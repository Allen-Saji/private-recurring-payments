import {useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {getNoirWallet, type ZcashConnectResult, type ZcashBalanceResult} from '@noir-wallet/sdk';
import {assertTestnet, fundingRequest, FUNDING_AMOUNT, formatZatoshis} from './policy.mjs';
import './style.css';

type WalletStatus = {address: string; chainTip?: number; scannedHeight?: number; totalZatoshis?: string; ironwoodSpendableZatoshis?: string};
type Receipt = {txid: string; confirmations: number; mined_height: number; verified_tip: number; pool: string};
type Status = {network: string; fundingReady?: boolean; operating: WalletStatus; supplier: WalletStatus; updatedAtUnix: number; receipts?: {funding?: Receipt; supplier?: Receipt}};
function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [account, setAccount] = useState<ZcashConnectResult | null>(null);
  const [balance, setBalance] = useState<ZcashBalanceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Connect Noir to fund the operating wallet.');
  const [error, setError] = useState('');
  const [funding, setFunding] = useState('');
  const [checkedHistory, setCheckedHistory] = useState(false);
  const inFlight = useRef(false);
  async function refresh() {
    const response = await fetch('/api/status', {cache:'no-store'});
    if (!response.ok) throw new Error('Wallet status is unavailable. Run the wallet sync command.');
    const next: Status = await response.json();
    if (next.network !== 'testnet') throw new Error('Backend must be on testnet.');
    assertTestnet(next.operating.address);
    setStatus(next);
    setFunding(localStorage.getItem(`funding:${next.operating.address}`) || '');
  }
  useEffect(() => { refresh().catch(e => setError(e.message)); }, []);
  useEffect(() => {
    function changed(event: StorageEvent) {if (status && event.key === `funding:${status.operating.address}`) setFunding(event.newValue || '');}
    window.addEventListener('storage',changed);
    return () => window.removeEventListener('storage',changed);
  }, [status]);
  async function connect() {
    setBusy(true); setError('');
    try {
      const wallet = getNoirWallet();
      if (!wallet) throw new Error('Noir was not detected. Install the testnet extension and reload this page.');
      const accounts = await wallet.zcash.getAccounts() ?? await wallet.zcash.connect();
      assertTestnet(accounts.shielded);
      setAccount(accounts);
      setBalance(await wallet.zcash.getBalance());
      setMessage('Connected. Review the destination below before opening Noir.');
    } catch (e) { setAccount(null); setBalance(null); setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function fund() {
    if (!status?.fundingReady || !account || inFlight.current || funding) return;
    inFlight.current = true; setBusy(true); setError('');
    let requested = false;
    try {
      if (!navigator.locks) throw new Error('This browser cannot safely coordinate wallet requests. Use a current Brave version.');
      await navigator.locks.request(`funding:${status.operating.address}`, {ifAvailable:true}, async lock => {
      if (!lock || localStorage.getItem(`funding:${status.operating.address}`)) throw new Error('A funding request already exists. Check Noir history.');
      const wallet = getNoirWallet();
      if (!wallet) throw new Error('Noir is unavailable.');
      const current = await wallet.zcash.getAccounts();
      if (!current || current.shielded !== account.shielded) throw new Error('Your wallet account changed. Connect again.');
      const request = fundingRequest(status.operating.address, current.shielded);
      localStorage.setItem(`funding:${status.operating.address}`, 'pending');
      setFunding('pending'); requested = true;
      const txid = await wallet.zcash.sendTransaction({...request, fundingSource:'shielded'});
      if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error('Noir returned an unexpected result. Check its transaction history.');
      localStorage.setItem(`funding:${status.operating.address}`, txid); setFunding(txid);
      setMessage('Noir submitted the funding payment. Run wallet sync to check the operating balance.');
      });
    } catch (e) {
      setError(`${(e as Error).message}${requested ? ' Check Noir history before another funding attempt; this request may have been submitted.' : ''}`);
    } finally { inFlight.current = false; setBusy(false); }
  }
  const primaryBalance = balance?.accounts.find(a => a.id === account?.accounts[0]?.id);
  const confirmedFunding = status?.receipts?.funding?.txid === funding && (status?.receipts?.funding?.confirmations ?? 0) > 0;
  return <main>
    <header><a className="wordmark" href="/">PRIVATE PAYMENTS</a><span className="network">Zcash testnet</span></header>
    <section className="intro"><p className="eyebrow">Wallet integration / 01</p><h1>Fund privately.<br/>Verify the receipt.</h1><p className="lede">Move test ZEC from Noir into a dedicated operating wallet. The next payment goes to an independent supplier wallet.</p></section>
    <div className="layout"><section className="panel"><div className="section-title"><span>01</span><h2>Your funding wallet</h2></div>
      <p>Noir keeps your keys and asks you to approve this one payment.</p>
      {account && <><label>Connected shielded address</label><code>{account.shielded}</code><div className="balance"><span>Available in Noir</span><strong>{primaryBalance?.synced ? (balance?.available ?? balance?.spendable ?? 'Unavailable') : 'Sync Noir first'} <small>TAZ</small></strong></div></>}
      <button disabled={busy} onClick={connect}>{account ? 'Refresh Noir connection' : 'Connect Noir testnet'}</button>
      <p className="help">Need the extension? <a href="https://github.com/NoirWallet/noir-wallet/releases/tag/v1.0.40" target="_blank" rel="noreferrer">Official Noir release</a>. Install the testnet build.</p>
    </section><section className="panel destination"><div className="section-title"><span>02</span><h2>Operating wallet</h2></div>
      <p>A separate testnet wallet used by the payment service.</p><label>Shielded funding destination</label><code>{status?.operating.address ?? 'Waiting for the wallet service...'}</code>
      <div className="amount"><span>Fund with</span><strong>{FUNDING_AMOUNT} <small>TAZ</small></strong></div>
      <p className="help">Network fee is additional. Noir will show the final fee before approval. Funding uses shielded funds only.</p>
      {!status?.fundingReady && <p className="help">Funding is paused until the backend passes its network compatibility check.</p>}
      <button className="primary" disabled={!account || !status?.fundingReady || busy || !!funding} onClick={fund}>{busy ? 'Waiting for Noir...' : funding ? 'Funding request recorded' : `Review ${FUNDING_AMOUNT} TAZ in Noir`}</button>
    </section></div>
    <section className="receipt" aria-live="polite"><div className="section-title"><span>03</span><h2>Receipt and wallet state</h2></div><p>{confirmedFunding ? 'Funding verified: the operating wallet decrypted 0.05 TAZ and the expected private memo.' : message}</p>{error && <p className="error" role="alert">{error}</p>}
      {funding && <><label>{confirmedFunding ? 'Verified Noir funding transaction' : `Funding submission ${funding === 'pending' ? '(response not yet confirmed)' : '(not confirmation of receipt)'}`}</label><code>{funding === 'pending' ? 'Check Noir transaction history before retrying.' : funding}</code></>}
      {status?.receipts?.funding && <p className="help">Noir funding: {status.receipts.funding.confirmations} confirmations at block {status.receipts.funding.verified_tip}. Received through {status.receipts.funding.pool}; no transparent inputs or outputs.</p>}
      {status?.receipts?.supplier && <p className="help">Supplier payment: 0.01 TAZ verified with {status.receipts.supplier.confirmations} confirmations at block {status.receipts.supplier.verified_tip}. Amount and invoice memo decrypted by the supplier wallet.</p>}
      {funding === 'pending' && !busy && <div className="recovery"><label><input type="checkbox" checked={checkedHistory} onChange={e=>setCheckedHistory(e.target.checked)}/> I checked Noir history and no funding transfer was submitted.</label><button disabled={!checkedHistory} onClick={async()=>{
        if (!status || !navigator.locks) return;
        await navigator.locks.request(`funding:${status.operating.address}`,{ifAvailable:true},async lock=>{
          if (!lock) {setError('Another tab still has an active Noir request.');return;}
          if (localStorage.getItem(`funding:${status.operating.address}`)!=='pending') {await refresh();return;}
          localStorage.removeItem(`funding:${status.operating.address}`); setFunding(''); setCheckedHistory(false); setError('');
        });
      }}>Allow a new funding request</button></div>}
      <div className="stats"><div><label>Operating total</label><strong>{formatZatoshis(status?.operating.totalZatoshis)} <small>TAZ</small></strong></div><div><label>Supplier total</label><strong>{formatZatoshis(status?.supplier.totalZatoshis)} <small>TAZ</small></strong></div><div><label>Operating scan height</label><strong>{status?.operating.scannedHeight ?? 'Pending'} / {status?.operating.chainTip ?? 'Pending'}</strong></div></div>
      <p className="help">Snapshot: {status?.updatedAtUnix ? new Date(status.updatedAtUnix*1000).toLocaleString() : 'unavailable'}. Balances update after the backend syncs; a transaction ID alone does not prove receipt.</p><button disabled={busy} onClick={() => refresh().catch(e=>setError(e.message))}>Refresh wallet snapshot</button>
    </section><footer>Testnet funds only. Recurring agreement enforcement is not active in this wallet integration.</footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
