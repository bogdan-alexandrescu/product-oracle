import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Each render test starts from an empty document.
afterEach(() => cleanup());
