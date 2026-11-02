# Asset storage

An ICP certified-assets canister for storing and serving files over HTTP.

The installing controller is always granted explicit `ManagePermissions`, even
when `InitArgs.set_permissions` replaces the initial permission lists. Additional
controllers can be placed in `set_permissions.manage_permissions` during
installation. Independently of the stored list, the certified-assets guards
authorize principals that are current canister controllers.

The canister preserves the official certified-assets CBOR stable-state format
and can restore the older Candid stable-state format during upgrades.
