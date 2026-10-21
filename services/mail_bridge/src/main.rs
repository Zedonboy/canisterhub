mod config;
mod http;
mod ic;
mod mail;
mod outbound;
mod smtp;
mod state;

use crate::config::Config;
use crate::state::AppState;
use std::sync::Arc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env().add_directive("mail_bridge=info".parse()?))
        .init();

    smtp::tls::install_default_crypto_provider();

    let config = Arc::new(Config::from_env()?);
    let agent = Arc::new(ic::agent::build_agent(&config).await?);
    let tls_acceptor = Arc::new(smtp::tls::build_acceptor(&config.tls_cert_path, &config.tls_key_path)?);
    let verifier = Arc::new(mail::auth::Verifier::new()?);

    tracing::info!(
        smtp_bind_addr = %config.smtp_bind_addr,
        http_bind_addr = %config.http_bind_addr,
        mail_domain = %config.mail_domain,
        dmarc_enforcement = config.dmarc_enforcement,
        dkim_signing = config.dkim_private_key_path.is_some(),
        "starting mail_bridge"
    );

    let state = AppState { config, agent, tls_acceptor, verifier };

    let smtp_state = state.clone();
    let smtp_task = tokio::spawn(async move { smtp::server::run(smtp_state).await });

    let app = http::routes::router(state.clone());
    let listener = tokio::net::TcpListener::bind(&state.config.http_bind_addr).await?;
    let http_task = tokio::spawn(async move { axum::serve(listener, app).await.map_err(anyhow::Error::from) });

    // Either server exiting (they're both meant to run forever) is fatal -
    // propagate whichever failed first rather than silently limping along
    // with only half the bridge working.
    tokio::select! {
        result = smtp_task => result??,
        result = http_task => result??,
    }
    Ok(())
}
