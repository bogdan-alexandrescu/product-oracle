import { RequestsScreen } from "../_components/RequestsScreen";

/**
 * Requests' To decide tab (C1): the requests nobody has decided yet, newest first, in the
 * queue's rows; a row opens the same inspector as All requests (qa-work-6). An interview's
 * requests are marked Unverified.
 */
export default function NewRequestsPage() {
  return <RequestsScreen view="new" />;
}
