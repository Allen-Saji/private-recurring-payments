import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

function Mark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
    >
      <path d="M5 15 35 3v12L17 23v13L5 29Z" fill="currentColor" />
      <path
        d="m43 19-12-7v13l-18 8v12l30-12Z"
        fill="currentColor"
        opacity=".65"
      />
    </svg>
  );
}

function Icon({
  name,
  className = "",
}: {
  name:
    | "arrow"
    | "check"
    | "plus"
    | "play"
    | "close"
    | "menu"
    | "file"
    | "repeat"
    | "eye"
    | "download";
  className?: string;
}) {
  const paths = {
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    check: <path d="m5 12 4 4 10-10" />,
    plus: <path d="M12 5v14M5 12h14" />,
    play: <path d="m9 5 10 7-10 7Z" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    menu: <path d="M4 8h16M4 16h16" />,
    file: (
      <>
        <path d="M14 3H6v18h12V7ZM14 3v5h4M9 12h6M9 16h6" />
      </>
    ),
    repeat: (
      <>
        <path d="M19 9a7 7 0 0 0-12-4L4 8m0-5v5h5M5 15a7 7 0 0 0 12 4l3-3m0 5v-5h-5" />
      </>
    ),
    eye: (
      <>
        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    download: <path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4" />,
  };
  return (
    <svg
      className={`icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function Agreement({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`agreement ${compact ? "agreement-compact" : ""}`}>
      <div className="agreement-top">
        <div className="supplier-symbol">
          <span />
          <span />
          <span />
        </div>
        <div>
          <strong>Network telemetry</strong>
          <span>Recurring network data</span>
        </div>
        <span className="verified">
          <Icon name="check" />
          Approved
        </span>
      </div>
      <div className="agreement-price">
        <span>Payment amount</span>
        <div>
          0.01 <small>TAZ / payment</small>
        </div>
      </div>
      <dl>
        <div>
          <dt>Next payment</dt>
          <dd>Every 10 minutes</dd>
        </div>
        <div>
          <dt>Network fee limit</dt>
          <dd>0.001 TAZ</dd>
        </div>
      </dl>
      <div className="agreement-bottom">
        <span className="status-dot" />
        Within your approved terms<span>EXAMPLE AGREEMENT</span>
      </div>
    </div>
  );
}

const steps = [
  {
    title: "Set the terms.",
    copy: "Choose a schedule and spending limit for network telemetry. Review the fixed amount, recipient, and fee allowance.",
    label: "01 / YOUR AGREEMENT",
    status: "Ready for review",
  },
  {
    title: "Let the routine run.",
    copy: "The signer checks each invoice against your agreement. Changed amounts or destinations are refused.",
    label: "02 / PAYMENT CHECK",
    status: "Terms match",
  },
  {
    title: "Keep the full picture.",
    copy: "Keep numbered invoices, signed billing records, and verified receipts together. Export your records or stop future payments.",
    label: "03 / YOUR RECEIPT",
    status: "Payment confirmed",
  },
];

function Walkthrough() {
  const [step, setStep] = useState(0);
  return (
    <section
      className="walkthrough section-wrap"
      id="how-it-works"
      aria-labelledby="flow-heading"
    >
      <div className="section-heading reveal">
        <span className="eyebrow">01 / A CLEAR AGREEMENT</span>
        <h2 id="flow-heading">
          One less thing
          <br />
          to <em>think about.</em>
        </h2>
        <p>
          Decide what can be paid.
          <br />
          Let the agreement handle the repetition.
        </p>
      </div>
      <div className="flow-grid reveal">
        <div
          className="step-list"
          role="tablist"
          aria-label="Payment walkthrough"
          aria-orientation="vertical"
        >
          {steps.map((item, i) => (
            <button
              key={item.title}
              id={`step-${i}`}
              role="tab"
              aria-selected={i === step}
              aria-controls="flow-panel"
              tabIndex={i === step ? 0 : -1}
              className={`step ${i === step ? "active" : ""}`}
              onClick={() => setStep(i)}
              onKeyDown={(event) => {
                const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
                if (!keys.includes(event.key)) return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? 2
                      : (step + (event.key === "ArrowDown" ? 1 : 2)) % 3;
                setStep(next);
                document.getElementById(`step-${next}`)?.focus();
              }}
            >
              <span className="step-number">0{i + 1}</span>
              <div>
                <h3>{item.title}</h3>
                <p>{item.copy}</p>
              </div>
              <Icon name="arrow" />
            </button>
          ))}
        </div>
        <div
          className={`flow-stage stage-${step}`}
          id="flow-panel"
          role="tabpanel"
          aria-labelledby={`step-${step}`}
          tabIndex={0}
        >
          <div className="stage-grid" aria-hidden="true" />
          <div className="stage-orbit" aria-hidden="true" />
          <div className="flow-document" key={step}>
            <span className="eyebrow">{steps[step].label}</span>
            <div className="document-head">
              <div className="supplier-symbol">
                <span />
                <span />
                <span />
              </div>
              <strong>Network telemetry</strong>
              <Icon name={step === 2 ? "check" : "file"} />
            </div>
            <div className="document-amount">
              0.01 <span>TAZ</span>
            </div>
            <p className="document-sub">
              {step === 2 ? "Recurring payment" : "Every 10 minutes"}
            </p>
            <dl>
              <div>
                <dt>{step === 2 ? "Payment date" : "Next payment"}</dt>
                <dd>Every 10 minutes</dd>
              </div>
              <div>
                <dt>Network fee limit</dt>
                <dd>0.001 TAZ</dd>
              </div>
              <div>
                <dt>{step === 2 ? "Settlement" : "Agreement ends"}</dt>
                <dd>{step === 2 ? "Shielded" : "After three payments"}</dd>
              </div>
            </dl>
            <div className="document-status">
              <span className="status-dot" />
              {steps[step].status}
            </div>
          </div>
          <p className="example-note">
            Example terms. Your workspace records the actual agreement and
            receipts.
          </p>
        </div>
      </div>
    </section>
  );
}

function App() {
  const [menu, setMenu] = useState(false);
  const [motionPaused, setMotionPaused] = useState(
    localStorage.getItem("tandem:motion") === "off",
  );
  const heroRef = useRef<HTMLDivElement>(null);
  const [parallax, setParallax] = useState({ x: 0, y: 0 });
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(preference.matches);
    update();
    preference.addEventListener("change", update);
    const observer = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
            observer.unobserve(entry.target);
          }
        }),
      { threshold: 0.12 },
    );
    document
      .querySelectorAll(".reveal")
      .forEach((node) => observer.observe(node));
    return () => {
      observer.disconnect();
      preference.removeEventListener("change", update);
    };
  }, []);
  const quiet = motionPaused || reducedMotion;
  return (
    <div className={`site ${quiet ? "motion-paused" : ""}`}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Tandem home">
          <Mark />
          tandem<span className="brand-period">.</span>
        </a>
        <nav
          aria-label="Main navigation"
          className={menu ? "open" : ""}
          onClick={() => setMenu(false)}
        >
          <a href="/services">Services</a>
          <a href="#how-it-works">How it works</a>
          <a href="/agents">For agents</a>
        </nav>
        <a className="button button-outline header-cta" href="/app">
          Sign in
          <Icon name="arrow" />
        </a>
        <button
          className="menu-toggle"
          aria-label={menu ? "Close menu" : "Open menu"}
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          <Icon name={menu ? "close" : "menu"} />
        </button>
      </header>
      <main id="main">
        <section className="hero" id="top">
          <div className="hero-copy">
            <p className="eyebrow">
              <span className="status-dot" />
              PRIVATE RECURRING PAYMENTS
            </p>
            <h1>
              Private payments.
              <br />
              On <em>your</em> terms.
            </h1>
            <p className="hero-lede">
              Private supplier payments. Signed invoices.
              <br />
              Approve the limits. Let the routine run.
            </p>
            <div className="hero-actions">
              <a className="button button-primary" href="/app?review">
                Explore Tandem
                <Icon name="arrow" />
              </a>
              <a className="text-link" href="/services">
                Browse services
                <Icon name="arrow" />
              </a>
            </div>
            <p className="hero-footnote">
              <span className="zcash-symbol" aria-hidden="true">
                Z
              </span>
              Built for shielded payments on Zcash NU7 testnet.
            </p>
          </div>
          <div
            className="hero-art"
            ref={heroRef}
            onPointerMove={(event) => {
              if (quiet || event.pointerType !== "mouse") return;
              const rect = heroRef.current!.getBoundingClientRect();
              setParallax({
                x: (event.clientX - rect.left) / rect.width - 0.5,
                y: (event.clientY - rect.top) / rect.height - 0.5,
              });
            }}
            onPointerLeave={() => setParallax({ x: 0, y: 0 })}
            style={
              {
                "--pointer-x": quiet ? 0 : parallax.x,
                "--pointer-y": quiet ? 0 : parallax.y,
              } as CSSProperties
            }
          >
            <div className="art-aura" aria-hidden="true" />
            <div className="sculpture-wrap">
              <img
                className="sculpture"
                src="/sealed-sculpture.png"
                width="1024"
                height="1024"
                alt="Sculptural cobalt enclosure with a warm metallic interior"
                fetchPriority="high"
              />
              <div className="hero-agreement">
                <Agreement />
              </div>
            </div>
            <div className="art-caption">
              <span className="caption-line" />
              An agreement you control.
            </div>
          </div>
          <div className="hero-bottom">
            <span>YOUR TERMS. EVERY TIME.</span>
            <a href="#product" aria-label="Discover the product">
              <span>Scroll to unfold</span>
              <span className="down-arrow">&#8595;</span>
            </a>
            <button
              onClick={() => {
                setMotionPaused(!motionPaused);
                localStorage.setItem(
                  "tandem:motion",
                  motionPaused ? "on" : "off",
                );
              }}
              aria-pressed={motionPaused}
            >
              {quiet ? "Motion off" : "Pause motion"}
              <span className="motion-bars" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </button>
          </div>
        </section>
        <section className="intro section-wrap" id="product">
          <div className="reveal">
            <span className="eyebrow">A RECORD FOR EVERY PAYMENT</span>
            <h2>
              Keep your payments moving.
              <br />
              Keep your business <em>yours.</em>
            </h2>
          </div>
          <div className="intro-bottom reveal">
            <p>
              Routine bills should not need your attention every time. Give each
              supplier a clear agreement, and keep control of what happens next.
            </p>
            <div className="principles">
              <span>
                <Icon name="file" />
                Terms you approve
              </span>
              <span>
                <Icon name="repeat" />
                Renewals you can track
              </span>
              <span>
                <Icon name="eye" />
                Privacy you can understand
              </span>
            </div>
          </div>
        </section>
        <Walkthrough />
        <section
          className="control section-wrap"
          aria-labelledby="control-heading"
        >
          <div className="reveal control-copy">
            <span className="eyebrow">02 / CONTROL THAT STAYS WITH YOU</span>
            <h2 id="control-heading">
              Approve the terms.
              <br />
              <em>Keep the limits.</em>
            </h2>
            <p>
              An approval belongs to a specific agreement. Changed terms require
              a new authorization.
            </p>
            <a className="text-link" href="#questions">
              A few things to know
              <Icon name="arrow" />
            </a>
          </div>
          <div className="boundaries reveal">
            <article>
              <span>01</span>
              <div>
                <h3>The amount stays agreed.</h3>
                <p>
                  A higher invoice needs fresh approval. The payment service
                  checks the terms before signing.
                </p>
              </div>
              <Icon name="check" />
            </article>
            <article>
              <span>02</span>
              <div>
                <h3>A retry is still one payment.</h3>
                <p>
                  The payment record follows the billing period, so another
                  invoice ID cannot reopen it.
                </p>
              </div>
              <Icon name="check" />
            </article>
            <article>
              <span>03</span>
              <div>
                <h3>You can stop what comes next.</h3>
                <p>
                  Revocation blocks future signing. Payments already signed or
                  sent are shown separately.
                </p>
              </div>
              <Icon name="check" />
            </article>
          </div>
        </section>
        <section
          className="privacy section-wrap"
          id="privacy"
          aria-labelledby="privacy-heading"
        >
          <div className="privacy-heading reveal">
            <Mark />
            <span className="eyebrow">03 / PRIVACY, IN PLAIN SIGHT</span>
            <h2 id="privacy-heading">
              Your business.
              <br />
              <em>Your business.</em>
            </h2>
            <p>
              Private payments should come with a clear explanation of who can
              see what.
            </p>
          </div>
          <div className="privacy-columns reveal">
            <article>
              <span className="eyebrow">ON THE PUBLIC CHAIN</span>
              <h3>Shielded payment details.</h3>
              <p>
                Shielded Zcash settlement keeps sender, recipient, and amount
                out of the public transaction record.
              </p>
            </article>
            <article>
              <span className="eyebrow">BETWEEN THE PEOPLE INVOLVED</span>
              <h3>Useful records remain.</h3>
              <p>
                Your business, supplier, and authorized payment service can
                access the records they handle. Signed invoices and payment
                receipts stay available in your workspace.
              </p>
            </article>
            <article>
              <span className="eyebrow">BEYOND THE PAYMENT</span>
              <h3>Trust has boundaries.</h3>
              <p>
                Wallet infrastructure can observe network metadata. Shielding a
                transaction does not automatically hide server logs or IP
                addresses.
              </p>
            </article>
          </div>
        </section>
        <section className="faq section-wrap" id="questions">
          <div className="reveal">
            <span className="eyebrow">A FEW THINGS TO KNOW</span>
            <h2>
              Clear from
              <br />
              the <em>start.</em>
            </h2>
          </div>
          <div className="faq-list reveal">
            {[
              [
                "Is this a wallet?",
                "Tandem handles recurring supplier agreements, shielded payments, and invoices. Fund your workspace from Noir; the payment service checks each renewal against your approved terms.",
              ],
              [
                "Can I pay any subscription?",
                "The supplier needs to accept the supported Zcash payment flow. This does not automatically pay arbitrary card subscriptions or services.",
              ],
              [
                "Does my agent control my money?",
                "The execution agent requests payments. A separate signer owns the spending key and checks the approved agreement against the transaction. You still need to trust the signer and its operator.",
              ],
              [
                "What happens when I stop an agreement?",
                "Stopping an agreement prevents new signatures once the signer records the revocation. It cannot undo a payment that has already been signed or settled.",
              ],
              [
                "Can I use it today?",
                "Open the review workspace with prefilled judge credentials to inspect real invoices without a wallet. Create your own account to fund a dedicated wallet and subscribe to Network Telemetry. Use testnet TAZ only; Tandem manages workspace signing keys.",
              ],
            ].map(([question, answer]) => (
              <details key={question}>
                <summary>
                  {question}
                  <Icon name="plus" />
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="closing section-wrap">
          <div className="closing-mark reveal">
            <Mark />
          </div>
          <span className="eyebrow reveal">
            PRIVATE PAYMENTS. ON YOUR TERMS.
          </span>
          <h2 className="reveal">
            Make room for
            <br />
            <em>everything else.</em>
          </h2>
          <a className="button button-primary reveal" href="/app?create">
            Create your workspace
            <Icon name="arrow" />
          </a>
          <p>Private workspaces. Shielded settlement. NU7 testnet.</p>
        </section>
      </main>
      <footer className="site-footer">
        <a className="brand" href="#top">
          <Mark />
          tandem<span className="brand-period">.</span>
        </a>
        <a href="/agents">For agents</a>
        <a href="/services">Service directory</a>
        <a href="#privacy">
          Privacy &amp; trust
          <Icon name="arrow" />
        </a>
        <span className="testnet-note">
          <span className="status-dot" />
          NU7 testnet
        </span>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
