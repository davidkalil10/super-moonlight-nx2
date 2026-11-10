use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    for name in [
        "MOONLIGHT_UPSTREAM_DIR",
        "MOONLIGHT_UPSTREAM_BUILD",
        "MOONLIGHT_NATIVE_LIB_DIR",
        "MOONLIGHT_NATIVE_INCLUDE_DIR",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    if env::var_os("CARGO_FEATURE_UPSTREAM_WORKER").is_none() {
        return;
    }
    let upstream = required_path("MOONLIGHT_UPSTREAM_DIR");
    let build = required_path("MOONLIGHT_UPSTREAM_BUILD");
    let libs = required_path("MOONLIGHT_NATIVE_LIB_DIR");
    let include = required_path("MOONLIGHT_NATIVE_INCLUDE_DIR");
    check_pin(
        &upstream.join("moonlight-embedded"),
        "f32e415aea6797d261d6b470dcf8bf18727341c2",
    );
    check_pin(
        &upstream.join("moonlight-common-c"),
        "b126e481a195fdc7152d211def17190e3434bcce",
    );
    check_pin(
        &upstream.join("moonlight-common-c/enet"),
        "dea6fb5414b180908b58c0293c831105b5d124dd",
    );
    let game = upstream.join("moonlight-embedded/libgamestream");
    let header = PathBuf::from("src/upstream_worker/upstream.h");
    let common = upstream.join("moonlight-common-c/src");
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR")).join("bindings.rs");
    let status = Command::new("bindgen")
        .arg(&header)
        .args([
            "--allowlist-type",
            "SERVER_DATA|APP_LIST|HTTP_DATA|DECODE_UNIT|LENTRY|STREAM_CONFIGURATION|DECODER_RENDERER_CALLBACKS|AUDIO_RENDERER_CALLBACKS|CONNECTION_LISTENER_CALLBACKS|OPUS_MULTISTREAM_CONFIGURATION|OpusMSDecoder",
            "--allowlist-function",
            "gs_init|gs_applist|gs_pair|gs_unpair|gs_quit_app|gs_start_app|http_init|http_create_data|http_request|http_free_data|http_cleanup|xml_search|LiInitializeServerInformation|LiInitializeStreamConfiguration|LiInitializeVideoCallbacks|LiInitializeAudioCallbacks|LiInitializeConnectionCallbacks|LiStartConnection|LiStopConnection|LiInterruptConnection|LiSendControllerArrivalEvent|LiGetEstimatedRttInfo|opus_multistream_decoder_create|opus_multistream_decoder_destroy|opus_multistream_decode|LiSendMultiControllerEvent|LiSendTouchEvent|LiSendControllerMotionEvent|LiSendMousePositionEvent|LiSendMouseButtonEvent|LiGetHostFeatureFlags|LiRequestIdrFrame",
            "--allowlist-var",
            "DR_OK|DR_NEED_IDR|FRAME_TYPE_IDR|CAPABILITY_DIRECT_SUBMIT|LI_FF_PEN_TOUCH_EVENTS|LI_TOUCH_EVENT_DOWN|LI_TOUCH_EVENT_UP|LI_TOUCH_EVENT_MOVE|LI_ROT_UNKNOWN|LI_ERR_UNSUPPORTED|VIDEO_FORMAT_H264|VIDEO_FORMAT_H265|VIDEO_FORMAT_AV1_MAIN8|STREAM_CFG_LOCAL|MOONLIGHT_AUDIO_STEREO|COLORSPACE_REC_709|COLOR_RANGE_LIMITED|ENCFLG_ALL|LI_CTYPE_XBOX|LI_CCAP_ANALOG_TRIGGERS|LI_CCAP_RUMBLE|LI_CCAP_ACCEL|LI_CCAP_GYRO|LI_MOTION_TYPE_ACCEL|LI_MOTION_TYPE_GYRO|BUTTON_ACTION_PRESS|BUTTON_ACTION_RELEASE|BUTTON_LEFT|A_FLAG|B_FLAG|X_FLAG|Y_FLAG|UP_FLAG|DOWN_FLAG|LEFT_FLAG|RIGHT_FLAG|LB_FLAG|RB_FLAG|PLAY_FLAG|BACK_FLAG|LS_CLK_FLAG|RS_CLK_FLAG|SPECIAL_FLAG",
            "--output",
        ])
        .arg(output)
        .arg("--")
        .arg(format!("-I{}", common.display()))
        .arg(format!("-I{}", game.display()))
        .arg(format!("-I{}", include.display()))
        .status()
        .expect("run bindgen");
    assert!(status.success(), "bindgen failed");
    for directory in [
        &build,
        &build.join("common-c"),
        &build.join("common-c/enet"),
        &libs,
    ] {
        println!("cargo:rustc-link-search=native={}", directory.display());
    }
    for archive in [
        "libgamestream.a",
        "common-c/libmoonlight-common-c.a",
        "common-c/enet/libenet.a",
    ] {
        println!("cargo:rerun-if-changed={}", build.join(archive).display());
    }
    for argument in [
        "-Wl,-Bstatic",
        "-lgamestream",
        "-lmoonlight-common-c",
        "-lenet",
        "-Wl,-Bdynamic",
        "-lopus",
        "-lcurl",
        "-lexpat",
        "-luuid",
        "-lssl",
        "-lcrypto",
    ] {
        println!("cargo:rustc-link-arg-bin=moonlight-nx2-upstream-worker={argument}");
    }
    println!("cargo:rerun-if-changed={}", header.display());
    for name in ["client.h", "http.h", "xml.h"] {
        println!("cargo:rerun-if-changed={}", game.join(name).display());
    }
    println!(
        "cargo:rerun-if-changed={}",
        common.join("Limelight.h").display()
    );
    println!("cargo:rerun-if-changed={}", include.join("opus").display());
}

fn required_path(name: &str) -> PathBuf {
    let path = PathBuf::from(env::var_os(name).unwrap_or_else(|| panic!("{name} is required")));
    assert!(path.is_absolute(), "{name} must be absolute");
    path
}

fn check_pin(path: &Path, expected: &str) {
    for name in [".git/HEAD", ".git/index"] {
        println!("cargo:rerun-if-changed={}", path.join(name).display());
    }
    let output = Command::new("git")
        .args(["-C"])
        .arg(path)
        .args(["rev-parse", "HEAD"])
        .output()
        .expect("check upstream pin");
    assert!(
        output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == expected,
        "wrong upstream revision in {}",
        path.display()
    );
    let clean = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["diff", "--quiet", "HEAD", "--"])
        .status()
        .expect("check upstream source changes");
    assert!(
        clean.success(),
        "modified upstream source in {}",
        path.display()
    );
}
