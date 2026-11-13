import { Button } from "@/components/ds";

/**
 * QA Nov 12 #14: the one empty state for alignment reports, the same on the Reports tab and on
 * Latest report: what Oracle does, and Generate now for a member who may.
 */
export function NoReportYet({
  canGenerate,
  onGenerate,
  testId,
}: {
  canGenerate: boolean;
  onGenerate: () => void;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      data-report-empty
      className="flex flex-col items-center gap-3 px-4 py-8 text-center text-[15px] text-text2"
    >
      <p>
        No report yet. Oracle makes one every week for the week that ended.
        {canGenerate
          ? " You can generate one now for the week so far."
          : " An owner can generate one now."}
      </p>
      {canGenerate && (
        <Button variant="primary" icon="plus" onClick={onGenerate}>
          Generate now
        </Button>
      )}
    </div>
  );
}
