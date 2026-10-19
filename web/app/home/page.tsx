import { Empty, Page, PageHeader, Panel } from "@/components/ds";

/** Home (I3). Its goals, Needs you and In flight come in the UI wave, once their APIs merge. */
export default function HomePage() {
  return (
    <Page>
      <PageHeader title="Home" />
      <Panel>
        <Empty icon="home" testId="home-empty">
          Nothing yet
        </Empty>
      </Panel>
    </Page>
  );
}
