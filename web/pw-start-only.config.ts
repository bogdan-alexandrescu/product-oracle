import base from "./playwright.config";
const port = process.env.E2E_PORT ?? "3100";
export default { ...base, webServer: { ...(base.webServer as object), command: `npm run start:mock -- -p ${port}` } };
