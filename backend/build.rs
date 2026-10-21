use std::env;

fn main() {
    println!("cargo:rerun-if-env-changed=IC_ENV");
    println!("cargo:rustc-check-cfg=cfg(vetkd_mainnet)");

    match env::var("IC_ENV") {
        Ok(value) if value == "ic" => println!("cargo:rustc-cfg=vetkd_mainnet"),
        Ok(value) if value == "local" => {}
        Ok(value) => panic!(
            "invalid IC_ENV={value:?}; expected `IC_ENV=ic` for mainnet or `IC_ENV=local` for development"
        ),
        Err(env::VarError::NotPresent) => {}
        Err(env::VarError::NotUnicode(_)) => {
            panic!("IC_ENV must be valid Unicode: `ic` or `local`")
        }
    }
}
