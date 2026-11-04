import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", timeout: 900_000, workers: 1, reporter: "line", use: { baseURL: "http://127.0.0.1:3393", launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } } });
