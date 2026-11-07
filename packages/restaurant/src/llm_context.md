{
  "description": "Restaurant menu and order management. The canister calculates totals using vendor-set per-portion and per-plate prices. Use this package for restaurant meals, dine-in, takeaway, and delivery orders.",
  "methods": [
    {
      "name": "ai_list_menu",
      "description": "Customer tool: list available menu items, price per portion, price per plastic plate, currency, and vendor payment terms.",
      "parameters": {"type":"object","properties":{},"additionalProperties":false}
    },
    {
      "name": "ai_place_order",
      "description": "Create a restaurant order for the current customer. Pass menu item IDs and portion counts only; never provide prices, totals, or plate counts. The canister uses the vendor's current per-portion price and automatically adds the vendor's plastic-plate charge once per menu line. Collect the customer's choice of DineIn, Takeaway, or Delivery. DineIn requires table_label; Delivery requires delivery_address. For prepaid items collect customer_email and send the returned checkout_url. Vendor-configured payment terms cannot be overridden. All lines must share currency and payment method.",
      "parameters": {
        "type":"object",
        "properties": {
          "items":{"type":"array","minItems":1,"maxItems":50,"items":{"type":"object","properties":{"menu_item_id":{"type":"integer","minimum":1},"portions":{"type":"integer","minimum":1}},"required":["menu_item_id","portions"],"additionalProperties":false}},
          "fulfillment":{"type":"string","enum":["DineIn","Takeaway","Delivery"]},
          "delivery_address":{"type":["string","null"]},
          "table_label":{"type":["string","null"]},
          "customer_name":{"type":["string","null"]},
          "customer_phone":{"type":["string","null"]},
          "customer_email":{"type":["string","null"],"format":"email"},
          "note":{"type":["string","null"]}
        },
        "required":["items","fulfillment"],
        "additionalProperties":false
      }
    },
    {
      "name":"ai_list_my_orders",
      "description":"List restaurant orders belonging to the current customer conversation.",
      "parameters":{"type":"object","properties":{},"additionalProperties":false}
    },
    {
      "name":"ai_get_my_order",
      "description":"Get one order belonging to the current customer. The canister hides orders belonging to other customers.",
      "parameters":{"type":"object","properties":{"order_id":{"type":"integer","minimum":1}},"required":["order_id"],"additionalProperties":false}
    },
    {
      "name":"ai_cancel_my_order",
      "description":"Cancel a pending cash-on-delivery order. Prepaid orders and orders already in preparation cannot be cancelled through chat; contact the restaurant.",
      "parameters":{"type":"object","properties":{"order_id":{"type":"integer","minimum":1}},"required":["order_id"],"additionalProperties":false}
    }
  ]
}
