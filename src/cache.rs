use std::{collections::BTreeMap, sync::Mutex};
use zcash_client_backend::{
    data_api::{
        chain::{BlockCache, BlockSource, error::Error},
        scanning::ScanRange,
    },
    proto::compact_formats::CompactBlock,
};
use zcash_protocol::consensus::BlockHeight;

#[derive(Default)]
pub struct MemoryCache(Mutex<BTreeMap<u64, CompactBlock>>);

impl BlockSource for MemoryCache {
    type Error = std::io::Error;
    fn with_blocks<F, E>(
        &self,
        from: Option<BlockHeight>,
        limit: Option<usize>,
        mut visit: F,
    ) -> Result<(), Error<E, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), Error<E, Self::Error>>,
    {
        let blocks = self
            .0
            .lock()
            .map_err(|_| Error::BlockSource(std::io::Error::other("cache poisoned")))?;
        for (_, block) in blocks
            .range(u64::from(from.unwrap_or(BlockHeight::from_u32(0)))..)
            .take(limit.unwrap_or(usize::MAX))
        {
            visit(block.clone())?;
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl BlockCache for MemoryCache {
    fn get_tip_height(&self, range: Option<&ScanRange>) -> std::io::Result<Option<BlockHeight>> {
        let blocks = self
            .0
            .lock()
            .map_err(|_| std::io::Error::other("cache poisoned"))?;
        Ok(blocks
            .keys()
            .rev()
            .find(|h| {
                range.is_none_or(|r| r.block_range().contains(&BlockHeight::from_u32(**h as u32)))
            })
            .map(|h| BlockHeight::from_u32(*h as u32)))
    }
    async fn read(&self, range: &ScanRange) -> std::io::Result<Vec<CompactBlock>> {
        let blocks = self
            .0
            .lock()
            .map_err(|_| std::io::Error::other("cache poisoned"))?;
        let mut result = Vec::new();
        for h in u64::from(range.block_range().start)..u64::from(range.block_range().end) {
            match blocks.get(&h) {
                Some(b) => result.push(b.clone()),
                None => break,
            }
        }
        Ok(result)
    }
    async fn insert(&self, blocks: Vec<CompactBlock>) -> std::io::Result<()> {
        let mut cache = self
            .0
            .lock()
            .map_err(|_| std::io::Error::other("cache poisoned"))?;
        for b in blocks {
            cache.insert(b.height, b);
        }
        Ok(())
    }
    async fn delete(&self, range: ScanRange) -> std::io::Result<()> {
        self.0
            .lock()
            .map_err(|_| std::io::Error::other("cache poisoned"))?
            .retain(|h, _| {
                !range
                    .block_range()
                    .contains(&BlockHeight::from_u32(*h as u32))
            });
        Ok(())
    }
}
