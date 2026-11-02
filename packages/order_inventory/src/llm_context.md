{
  "description": "SME inventory and ordering. Customers can browse available products/services, place orders with a required delivery address and optional GPS coordinates, review their orders, and cancel pending orders. Authorized SME staff can manage inventory and order status.",
  "methods": [
    {
      "name": "ai_list_inventory",
      "description": "List active products and services currently available to order. Prices are integer minor currency units.",
      "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
    },
    {
      "name": "ai_place_order",
      "description": "Create a cash-on-delivery or prepaid order for the current customer. Prices and totals are recomputed by the canister. Prepaid orders remain AwaitingPayment until a trusted payment processor verifies exact payment; the agent cannot mark them paid. A delivery address is required. GPS latitude and longitude are optional, but must be supplied together.",
      "parameters": {
        "type": "object",
        "properties": {
          "items": {
            "type": "array",
            "minItems": 1,
            "maxItems": 50,
            "items": {
              "type": "object",
              "properties": { "inventory_id": { "type": "integer", "minimum": 1 }, "quantity": { "type": "integer", "minimum": 1 } },
              "required": ["inventory_id", "quantity"],
              "additionalProperties": false
            }
          },
          "customer_name": { "type": ["string", "null"] },
          "customer_phone": { "type": ["string", "null"] },
          "delivery_location": {
            "type": "object",
            "properties": {
              "address": { "type": "string", "minLength": 1 },
              "latitude": { "type": ["number", "null"], "minimum": -90, "maximum": 90 },
              "longitude": { "type": ["number", "null"], "minimum": -180, "maximum": 180 },
              "instructions": { "type": ["string", "null"] }
            },
            "required": ["address"],
            "additionalProperties": false
          },
          "note": { "type": ["string", "null"] }
          ,"payment_method": { "type": ["string", "null"], "enum": ["CashOnDelivery", "Prepaid", null], "description": "Defaults to CashOnDelivery when omitted." }
        },
        "required": ["items", "delivery_location"],
        "additionalProperties": false
      }
    },
    {
      "name": "ai_list_my_orders",
      "description": "List orders belonging to the current customer conversation.",
      "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
    },
    {
      "name": "ai_cancel_my_order",
      "description": "Cancel one of the current customer's pending orders.",
      "parameters": {
        "type": "object",
        "properties": { "order_id": { "type": "integer", "minimum": 1 } },
        "required": ["order_id"],
        "additionalProperties": false
      }
    },
    {
      "name": "ai_add_inventory",
      "description": "Staff only: add a product or service. stock_quantity may be null for untracked services.",
      "parameters": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "description": { "type": "string" },
          "sku": { "type": ["string", "null"] },
          "kind": { "type": "string", "enum": ["Product", "Service"] },
          "price_minor": { "type": "integer", "minimum": 0 },
          "currency": { "type": "string" },
          "stock_quantity": { "type": ["integer", "null"], "minimum": 0 }
        },
        "required": ["name", "description", "kind", "price_minor", "currency"],
        "additionalProperties": false
      }
    },
    {
      "name": "ai_list_all_inventory",
      "description": "Staff only: list every product and service, including inactive items and current stock levels.",
      "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
    },
    {
      "name": "ai_update_inventory",
      "description": "Staff only: update an existing product/service, stock level, price, or availability.",
      "parameters": {
        "type": "object",
        "properties": {
          "id": { "type": "integer", "minimum": 1 },
          "update": {
            "type": "object",
            "properties": {
              "name": { "type": ["string", "null"] },
              "description": { "type": ["string", "null"] },
              "sku": { "type": ["string", "null"] },
              "kind": { "type": ["string", "null"], "enum": ["Product", "Service", null] },
              "price_minor": { "type": ["integer", "null"], "minimum": 0 },
              "currency": { "type": ["string", "null"] },
              "stock_quantity": { "type": ["integer", "null"], "minimum": 0 },
              "track_stock": { "type": ["boolean", "null"] },
              "active": { "type": ["boolean", "null"] }
            },
            "additionalProperties": false
          }
        },
        "required": ["id", "update"],
        "additionalProperties": false
      }
    },
    {
      "name": "ai_list_orders",
      "description": "Staff only: list all orders, optionally filtered by status.",
      "parameters": {
        "type": "object",
        "properties": { "status": { "type": ["string", "null"], "enum": ["AwaitingPayment", "Pending", "Confirmed", "Preparing", "Ready", "OutForDelivery", "Completed", "Cancelled", "Expired", null] } },
        "additionalProperties": false
      }
    },
    {
      "name": "ai_update_order_status",
      "description": "Staff only: move an order through its fulfillment workflow or cancel it.",
      "parameters": {
        "type": "object",
        "properties": {
          "order_id": { "type": "integer", "minimum": 1 },
          "status": { "type": "string", "enum": ["Confirmed", "Preparing", "Ready", "OutForDelivery", "Completed", "Cancelled"] }
        },
        "required": ["order_id", "status"],
        "additionalProperties": false
      }
    },
    {
      "name": "ai_list_order_audit",
      "description": "Staff only: list the append-only audit history for one order, including placement, verified payment, failures, status changes, expiry, cancellation, collection, and refunds.",
      "parameters": {
        "type": "object",
        "properties": { "order_id": { "type": "integer", "minimum": 1 } },
        "required": ["order_id"],
        "additionalProperties": false
      }
    }
  ]
}
