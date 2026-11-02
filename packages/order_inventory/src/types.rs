use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};

#[derive(
    CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord,
)]
pub enum AiChannel {
    WhatsApp,
    Telegram,
    Email,
    /// A customer signed in with Internet Identity on the public storefront
    /// (or the agent's web chat); `session_id` is their principal's text.
    Web,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct AiContext {
    pub agent: Principal,
    pub channel: AiChannel,
    pub session_id: String,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct CustomerIdentity {
    pub channel: AiChannel,
    pub session_id: String,
}

impl From<&AiContext> for CustomerIdentity {
    fn from(value: &AiContext) -> Self {
        Self {
            channel: value.channel,
            session_id: value.session_id.clone(),
        }
    }
}

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum InventoryKind {
    Product,
    Service,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct InventoryItem {
    pub id: u64,
    pub name: String,
    pub description: String,
    pub sku: Option<String>,
    pub kind: InventoryKind,
    pub price_minor: u64,
    pub currency: String,
    /// Public http(s) URL of the item's picture, normally a file on a
    /// separate asset-storage canister. Items stored before this field
    /// existed decode as `None`.
    #[serde(default)]
    pub image_url: Option<String>,
    /// `None` means stock is not tracked (normally useful for services).
    pub stock_quantity: Option<u64>,
    pub active: bool,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct CreateInventoryItem {
    pub name: String,
    pub description: String,
    pub sku: Option<String>,
    pub kind: InventoryKind,
    pub price_minor: u64,
    pub currency: String,
    /// See `InventoryItem::image_url`.
    #[serde(default)]
    pub image_url: Option<String>,
    pub stock_quantity: Option<u64>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct UpdateInventoryItem {
    pub name: Option<String>,
    pub description: Option<String>,
    pub sku: Option<String>,
    pub kind: Option<InventoryKind>,
    pub price_minor: Option<u64>,
    pub currency: Option<String>,
    /// Sets the item's image URL; an empty string removes it.
    pub image_url: Option<String>,
    pub stock_quantity: Option<u64>,
    /// Set false to stop tracking stock; set true with `stock_quantity` to start.
    pub track_stock: Option<bool>,
    pub active: Option<bool>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct DeliveryLocation {
    pub address: String,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub instructions: Option<String>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct OrderItemRequest {
    pub inventory_id: u64,
    pub quantity: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PlaceOrder {
    pub items: Vec<OrderItemRequest>,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub delivery_location: DeliveryLocation,
    pub note: Option<String>,
    /// Omitted by older clients and treated as cash on delivery.
    #[serde(default)]
    pub payment_method: Option<PaymentMethod>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct OrderLine {
    pub inventory_id: u64,
    pub name: String,
    pub kind: InventoryKind,
    pub unit_price_minor: u64,
    pub quantity: u64,
    pub line_total_minor: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderStatus {
    AwaitingPayment,
    Pending,
    Confirmed,
    Preparing,
    Ready,
    OutForDelivery,
    Completed,
    Cancelled,
    Expired,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PaymentMethod {
    Prepaid,
    #[default]
    CashOnDelivery,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PaymentStatus {
    AwaitingPayment,
    Paid,
    Failed,
    RefundPending,
    PartiallyRefunded,
    Refunded,
    #[default]
    CashOnDeliveryPending,
    CashOnDeliveryCollected,
    Expired,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Order {
    pub id: u64,
    pub customer: CustomerIdentity,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub items: Vec<OrderLine>,
    pub total_minor: u64,
    pub currency: String,
    pub delivery_location: DeliveryLocation,
    pub note: Option<String>,
    pub status: OrderStatus,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub payment_method: PaymentMethod,
    #[serde(default)]
    pub payment_status: PaymentStatus,
    /// Immutable merchant reference supplied to the payment provider.
    #[serde(default)]
    pub payment_reference: Option<String>,
    #[serde(default)]
    pub amount_paid_minor: u64,
    #[serde(default)]
    pub amount_refunded_minor: u64,
    /// Prepaid stock is reserved until this timestamp. Cash-on-delivery
    /// orders do not expire automatically.
    #[serde(default)]
    pub reservation_expires_at: Option<u64>,
    #[serde(default)]
    pub stock_released: bool,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PaymentRecord {
    pub order_id: u64,
    pub method: PaymentMethod,
    pub status: PaymentStatus,
    pub expected_amount_minor: u64,
    pub currency: String,
    pub merchant_reference: String,
    pub amount_paid_minor: u64,
    pub amount_refunded_minor: u64,
    pub provider: Option<String>,
    pub provider_transaction_id: Option<String>,
    pub last_failure: Option<String>,
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
pub struct RecordPaymentFailure {
    pub order_id: u64,
    pub provider: String,
    pub reference: String,
    pub reason: String,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RecordRefund {
    pub order_id: u64,
    pub provider: String,
    pub transaction_id: String,
    pub amount_minor: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RecordCashCollection {
    pub order_id: u64,
    pub receipt_reference: String,
    pub amount_minor: u64,
    pub currency: String,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct AuditEntry {
    pub id: u64,
    pub order_id: Option<u64>,
    pub actor: String,
    pub action: String,
    pub details: String,
    pub at: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct BusinessProfile {
    pub name: String,
    pub currency: String,
}

impl Default for BusinessProfile {
    fn default() -> Self {
        Self {
            name: "My Business".to_string(),
            currency: "USD".to_string(),
        }
    }
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Settings {
    pub business: BusinessProfile,
    pub trusted_agents: Vec<Principal>,
    pub staff: Vec<CustomerIdentity>,
    #[serde(default)]
    pub trusted_payment_processors: Vec<Principal>,
    #[serde(default = "default_reservation_ttl_ns")]
    pub prepaid_reservation_ttl_ns: u64,
}

pub const fn default_reservation_ttl_ns() -> u64 {
    30 * 60 * 1_000_000_000
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            business: BusinessProfile::default(),
            trusted_agents: Vec::new(),
            staff: Vec::new(),
            trusted_payment_processors: Vec::new(),
            prepaid_reservation_ttl_ns: default_reservation_ttl_ns(),
        }
    }
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum OrderError {
    Unauthorized(String),
    InvalidInput(String),
    NotFound(String),
    Conflict(String),
    Internal(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize)]
    struct LegacySettings {
        business: BusinessProfile,
        trusted_agents: Vec<Principal>,
        staff: Vec<CustomerIdentity>,
    }

    #[derive(Serialize)]
    struct LegacyOrder {
        id: u64,
        customer: CustomerIdentity,
        customer_name: Option<String>,
        customer_phone: Option<String>,
        items: Vec<OrderLine>,
        total_minor: u64,
        currency: String,
        delivery_location: DeliveryLocation,
        note: Option<String>,
        status: OrderStatus,
        created_at: u64,
        updated_at: u64,
    }

    #[test]
    fn settings_added_for_payments_have_upgrade_safe_defaults() {
        let legacy = LegacySettings {
            business: BusinessProfile::default(),
            trusted_agents: vec![],
            staff: vec![],
        };
        let mut bytes = Vec::new();
        ciborium::into_writer(&legacy, &mut bytes).unwrap();
        let decoded: Settings = ciborium::from_reader(bytes.as_slice()).unwrap();
        assert!(decoded.trusted_payment_processors.is_empty());
        assert_eq!(
            decoded.prepaid_reservation_ttl_ns,
            default_reservation_ttl_ns()
        );
    }

    #[test]
    fn existing_orders_decode_as_uncollected_cash_on_delivery() {
        let legacy = LegacyOrder {
            id: 7,
            customer: CustomerIdentity {
                channel: AiChannel::WhatsApp,
                session_id: "customer".to_string(),
            },
            customer_name: None,
            customer_phone: None,
            items: vec![],
            total_minor: 100,
            currency: "NGN".to_string(),
            delivery_location: DeliveryLocation {
                address: "Lagos".to_string(),
                latitude: None,
                longitude: None,
                instructions: None,
            },
            note: None,
            status: OrderStatus::Pending,
            created_at: 1,
            updated_at: 1,
        };
        let mut bytes = Vec::new();
        ciborium::into_writer(&legacy, &mut bytes).unwrap();
        let decoded: Order = ciborium::from_reader(bytes.as_slice()).unwrap();
        assert_eq!(decoded.payment_method, PaymentMethod::CashOnDelivery);
        assert_eq!(decoded.payment_status, PaymentStatus::CashOnDeliveryPending);
        assert_eq!(decoded.amount_paid_minor, 0);
    }
}
