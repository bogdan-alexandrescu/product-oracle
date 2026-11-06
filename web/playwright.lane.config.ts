import base from "./playwright.config";
export default { ...base, testDir: "./e2e", webServer: { ...base.webServer, command: "npm run start:mock -- -p 3393" } };
