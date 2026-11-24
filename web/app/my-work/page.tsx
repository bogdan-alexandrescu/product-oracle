// MOCK-HOOK: the whole file. My work mock-up route (#1798 MW1 a), Detailed. Never merged.
import { createFileRoute } from '@tanstack/react-router';

import { MyWorkPage } from '@/components/simple/MyWorkMock';

const DetailedMyWork = () => <MyWorkPage detailed />; // MOCK-HOOK

export const Route = createFileRoute('/my-work/')({ component: DetailedMyWork }); // MOCK-HOOK
