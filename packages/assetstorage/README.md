# Asset storage

An ICP certified-assets canister for storing and serving files over HTTP.

Its single install argument is CanisterHub `ProjectContext`, matching every
other package. Controllers can read the stored context with
`get_project_context`; it is preserved across upgrades together with the
certified-assets state.

The installing controller is granted explicit `ManagePermissions`. Prepare,
commit, and management permission lists are edited after installation through
the package's dynamic configuration. Independently of the stored list, the
certified-assets guards authorize principals that are current canister
controllers.

The canister wraps the official certified-assets CBOR state with its project
context and can still restore both the previous raw-CBOR state and the older
Candid stable-state format during upgrades.
