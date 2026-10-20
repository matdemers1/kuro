use std::net::SocketAddr;
use std::sync::Arc;

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    // Bound on all interfaces *inside* the compose network; compose publishes no port for it.
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    println!("{{\"level\":\"info\",\"msg\":\"kuro-cr listening\",\"port\":{port}}}");
    axum::serve(listener, kuro_cr::router(Arc::new(kuro_cr::cr::LiveCr)))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("serve");
}
