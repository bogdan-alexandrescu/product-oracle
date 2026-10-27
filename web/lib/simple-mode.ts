/** Simple mode (#723) is behind ORACLE_SIMPLE_MODE (off by default): the web reads it as
 * NEXT_PUBLIC_ORACLE_SIMPLE_MODE=1; the mock build turns it on so its specs drive Simple. */
export const SIMPLE_MODE =
  process.env.NEXT_PUBLIC_ORACLE_SIMPLE_MODE === "1" || process.env.NEXT_PUBLIC_API_MOCKS === "1";
