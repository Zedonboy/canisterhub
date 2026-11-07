# Restaurant package

`restaurant.wasm` serves an embedded owner admin UI at `/admin/` (the Admin
link in its dynamic-config links): menu management (per-portion and
plastic-plate pricing, payment terms, availability) and the kitchen order
board (status moves and cash-on-delivery collection). Controllers manage the
same features through the Candid endpoints `create_menu_item`,
`update_menu_item`, `update_order_status`, `record_cash_collection`, and
`list_orders`.

`restaurant.wasm` provides customer AI tools for browsing the menu and placing
or managing the current customer's orders. Menu prices are vendor-controlled:
each item has a per-portion price and a plastic-plate charge. Customers provide
menu item IDs and portion counts; the canister automatically charges one plate
per menu line and calculates the total. Prices and totals are never accepted
from the agent.

Orders support dine-in, takeaway, delivery, cash on delivery, and prepaid
checkout through the configured Kora or Paystack payment package. The package
verifies agent callers against the protocol backend's project membership API.

For verified prepaid receipts, install the restaurant package in the project
and refresh the agent's project context; the agent records the restaurant
canister as an authorized business-message sender.

The package exposes its customer AI tool schema through `llm_context` and uses
`project_id`, `protocol_id`, and `payment_canister` in dynamic configuration.
