pub mod collector;
pub mod model;
pub mod store;
#[cfg(test)]
mod tests;

pub const PROVIDER_USAGE_FILE: &str = "/home/node/.claude/tdc/usage-provider.json";
/// Pending source snapshot for a running container.  It is atomically promoted
/// by the Claude wrapper immediately before the next Claude process starts, so
/// an already-running process keeps the pricing/auth snapshot it started with.
pub const PROVIDER_USAGE_PENDING_FILE: &str = "/home/node/.claude/tdc/usage-provider.pending.json";
