use ic_cdk::stable;
use ic_certified_assets::{StableStateV1, StableStateV2};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct StableEnvelope {
    version: u8,
    assets: StableStateV2,
    project_context: Option<canister_hub_sdk::ProjectContext>,
}

pub fn save_stable_state(
    stable_state: &StableStateV2,
    project_context: Option<canister_hub_sdk::ProjectContext>,
) -> Result<(), serde_cbor::Error> {
    let mut stable_writer = stable::StableWriter::default();
    serde_cbor::to_writer(
        &mut stable_writer,
        &StableEnvelope {
            version: 1,
            assets: stable_state.clone(),
            project_context,
        },
    )
}

pub fn is_candid_stable_state() -> bool {
    let mut maybe_magic_bytes = vec![0u8; 4];
    stable::stable_read(0, &mut maybe_magic_bytes);
    maybe_magic_bytes == b"DIDL"
}

pub fn load_candid_stable_state() -> Result<StableStateV1, String> {
    let (stable_state,) = ic_cdk::storage::stable_restore()?;
    Ok(stable_state)
}

pub fn load_stable_state(
) -> Result<(StableStateV2, Option<canister_hub_sdk::ProjectContext>), serde_cbor::Error> {
    match from_reader_ignore_trailing_data::<StableEnvelope, _>(stable::StableReader::default()) {
        Ok(envelope) if envelope.version == 1 => Ok((envelope.assets, envelope.project_context)),
        _ => from_reader_ignore_trailing_data(stable::StableReader::default())
            .map(|assets| (assets, None)),
    }
}

fn from_reader_ignore_trailing_data<T, R>(reader: R) -> Result<T, serde_cbor::Error>
where
    T: serde::de::DeserializeOwned,
    R: std::io::Read,
{
    let mut deserializer = serde_cbor::de::Deserializer::from_reader(reader);
    let value = serde::de::Deserialize::deserialize(&mut deserializer)?;
    // Stable memory can contain bytes left over from a previously larger state.
    Ok(value)
}
