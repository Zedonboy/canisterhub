use crate::config::Config;
use crate::mail::auth::Verifier;
use ic_agent::Agent;
use std::sync::Arc;
use tokio_rustls::TlsAcceptor;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub agent: Arc<Agent>,
    pub tls_acceptor: Arc<TlsAcceptor>,
    pub verifier: Arc<Verifier>,
}
