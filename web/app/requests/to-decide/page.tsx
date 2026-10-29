import { RequestsScreen } from "../_components/RequestsScreen";

/**
 * Requests' To decide tab (C1): the requests nobody has decided yet, newest first, in the
 * queue's rows; a row opens the same inspector as All requests (qa-work-6). An interview's
 * requests are marked Unverified. rirs-36: its address names the tab (/requests/new redirects here, opening New request).
 */
export default function ToDecidePage() {
  return <RequestsScreen view="new" />;
}
