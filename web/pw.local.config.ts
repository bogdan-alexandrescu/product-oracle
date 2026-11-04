// LOCAL ONLY, never committed: serve the mock build made beforehand (the build OOMs in this pod when run by Playwright).
import base from "./playwright.config";
const PORT = Number(process.env.E2E_PORT ?? 3100);
export default { ...base, webServer: { ...base.webServer, command: `npm run start:mock -- -p ${PORT}` } };
