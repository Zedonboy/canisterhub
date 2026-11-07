use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};

#[derive(
    CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord,
)]
pub enum AiChannel {
    WhatsApp,
    Telegram,
    Email,
    Web,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct AiContext {
    pub project_id: String,
    pub agent_canister_id: Principal,
    pub channel: AiChannel,
    pub session_id: String,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct CustomerIdentity {
    pub channel: AiChannel,
    pub session_id: String,
}

impl From<&AiContext> for CustomerIdentity {
    fn from(ctx: &AiContext) -> Self {
        Self {
            channel: ctx.channel,
            session_id: ctx.session_id.clone(),
        }
    }
}

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PaymentMethod {
    Prepaid,
    #[default]
    CashOnDelivery,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum FulfillmentMethod {
    DineIn,
    Takeaway,
    Delivery,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestaurantOrderStatus {
    AwaitingPayment,
    Pending,
    Preparing,
    Ready,
    Served,
    OutForDelivery,
    Completed,
    Cancelled,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestaurantPaymentStatus {
    AwaitingPayment,
    Paid,
    Failed,
    CashOnDeliveryPending,
    CashOnDeliveryCollected,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct MenuItem {
    pub id: u64,
    pub name: String,
    pub description: String,
    pub price_per_portion_minor: u64,
    pub plate_price_minor: u64,
    pub image_url: Option<String>,
    pub currency: String,
    pub payment_method: PaymentMethod,
    pub available: bool,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct CreateMenuItem {
    pub name: String,
    pub description: String,
    pub price_per_portion_minor: u64,
    pub plate_price_minor: u64,
    pub image_url: Option<String>,
    pub currency: String,
    pub payment_method: PaymentMethod,
    pub available: bool,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct UpdateMenuItem {
    pub name: Option<String>,
    pub description: Option<String>,
    pub price_per_portion_minor: Option<u64>,
    pub plate_price_minor: Option<u64>,
    /// Empty string clears the current photo; omitted leaves it unchanged.
    pub image_url: Option<String>,
    pub currency: Option<String>,
    pub payment_method: Option<PaymentMethod>,
    pub available: Option<bool>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RestaurantOrderRequestLine {
    pub menu_item_id: u64,
    pub portions: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PlaceRestaurantOrder {
    pub items: Vec<RestaurantOrderRequestLine>,
    pub fulfillment: FulfillmentMethod,
    pub delivery_address: Option<String>,
    pub table_label: Option<String>,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub customer_email: Option<String>,
    pub note: Option<String>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RestaurantOrderLine {
    pub menu_item_id: u64,
    pub name: String,
    pub portions: u64,
    pub price_per_portion_minor: u64,
    pub plates: u64,
    pub plate_price_minor: u64,
    pub line_total_minor: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RestaurantOrder {
    pub id: u64,
    pub customer: CustomerIdentity,
    pub agent_canister_id: Principal,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub customer_email: Option<String>,
    pub items: Vec<RestaurantOrderLine>,
    pub total_minor: u64,
    pub currency: String,
    pub fulfillment: FulfillmentMethod,
    pub delivery_address: Option<String>,
    pub table_label: Option<String>,
    pub note: Option<String>,
    pub status: RestaurantOrderStatus,
    pub payment_method: PaymentMethod,
    pub payment_status: RestaurantPaymentStatus,
    pub merchant_reference: String,
    pub checkout_url: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RecordPayment {
    pub order_id: u64,
    pub merchant_reference: String,
    pub provider: String,
    pub transaction_id: String,
    pub amount_minor: u64,
    pub currency: String,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RecordCashCollection {
    pub order_id: u64,
    pub receipt_reference: String,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct OrderError {
    pub message: String,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum RestaurantError {
    Unauthorized(String),
    InvalidInput(String),
    NotFound(String),
    Conflict(String),
    Internal(String),
}
