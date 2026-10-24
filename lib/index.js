import gradient from "gradient-string";
import makeWASocket from "./Socket/index.js";
const banner = ["╭─────────────────────────────────────────────────────────────────────────────╮", "│                                                                             │", "│    █████  ██    ██  ██████  ███████ ███    ███ ██    ██ ██                  │", "│   ██   ██  ██  ██  ██       ██      ████  ████ ██    ██ ██                  │", "│   ███████   ████   ██   ███ █████   ██ ████ ██ ██    ██ ██                  │", "│   ██   ██    ██    ██    ██ ██      ██  ██  ██ ██    ██                     │", "│   ██   ██    ██     ██████  ███████ ██      ██  ██████  ██                  │", "│                                                                             │", "╰─────────────────────────────────────────────────────────────────────────────╯"].join("\n");
const info = ["╭──────────────────────────────────────────────────────────────╮", "│                                                              │", "│  ◆  Package  ›  @aygemuy/baileys                             │", "│  ◆  Version  ›  3.0.3                                        │", "│  ◆  Status   ›  Active & Stable                              │", "│                                                              │", "├──────────────────────────── ◇◆◇ ─────────────────────────────┤", "│                                                              │", "│  ✦  WhatsApp Web API Client                                  │", "│  ✦  Interactive Buttons  ·  Products  ·  Events  ·  Media    │", "│  ✦  End-to-End Encryption  ·  Multi-Device Support           │", "│  ✦  Business API  ·  Channels  ·  Status Updates             │", "│                                                              │", "├──────────────────────────── ◇◆◇ ─────────────────────────────┤", "│                                                              │", "│  ◈  Author   ›  AyGemuy                                      │", "│  ◈  GitHub   ›  github.com/aygemuy                          │", "│  ◈  Support  ›  Join our community for updates             │", "│                                                              │", "╰──────────────────────────────────────────────────────────────╯"].join("\n");
console.log(gradient(["#FF6EC7", "#FF1493", "#7B2FBE", "#00FFFF"])(banner));
console.log(gradient(["#00FFFF", "#00BFFF", "#FF6EC7"])(info));
console.log(gradient(["#00FF88", "#FFFFFF"])("\n🎯 Initializing AyGemuy Baileys Socket Connection...\n"));
export * from "../WAProto/index.js";
export * from "./Utils/index.js";
export * from "./Store/index.js";
export * from "./Types/index.js";
export * from "./Defaults/index.js";
export * from "./WABinary/index.js";
export * from "./WAM/index.js";
export * from "./WAUSync/index.js";
export * from "./Socket/index.js";
export * from "./Builders/index.js";
export * from './VoIP/index.js';
export {
  makeWASocket
};
export default makeWASocket;