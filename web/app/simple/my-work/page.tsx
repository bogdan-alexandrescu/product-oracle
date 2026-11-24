// MOCK-HOOK: the whole file. My work mock-up route (#1798 MW1 a), Simple. Never merged.
import { createFileRoute } from '@tanstack/react-router';

import { MyWorkPage } from '@/components/simple/MyWorkMock';

const SimpleMyWork = () => <MyWorkPage />; // MOCK-HOOK

export const Route = createFileRoute('/simple/my-work/')({ component: SimpleMyWork }); // MOCK-HOOK
