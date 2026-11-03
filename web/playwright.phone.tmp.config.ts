import { devices } from "@playwright/test";
import base from "./playwright.config";

export default { ...base, projects: [{ name: "phone", use: { ...devices["Pixel 7"], browserName: "chromium" as const, viewport: { width: 390, height: 844 } } }] };
