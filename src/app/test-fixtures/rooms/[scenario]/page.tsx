import {notFound} from "next/navigation";

import RoomClient from "../../../room-client";
import {roomStateForClient} from "@/lib/room-loader";
import {fixtureRoom, isUiFixtureScenario} from "@/lib/ui-test-fixtures";

export default async function UiFixturePage({params}: {params: Promise<{scenario: string}>}) {
  if (process.env.UI_TEST_FIXTURES !== "1") notFound();
  const {scenario} = await params;
  if (!isUiFixtureScenario(scenario)) notFound();
  const fixture = fixtureRoom(scenario);
  return <main data-ui-fixture={scenario}>
    <nav><a className="brand" href="/">TRADE<span>TABLE</span></a><div className="network"><i className="live" /> TEST FIXTURE</div><span>NO BROADCASTS</span></nav>
    <header className="proofHero roomHero"><p className="kicker">DETERMINISTIC BROWSER STATE / {scenario}</p><h1>Real interface.<br /><em>Controlled authority.</em></h1></header>
    <RoomClient room={fixture.room} initialCore={roomStateForClient(fixture.core)} initialLive={roomStateForClient(fixture.live)}
      initialAuthority={fixture.authority} initialDelegated={fixture.delegated} initialObservedAt={Date.now() + 3_600_000}
      initialPending={fixture.pending ? roomStateForClient(fixture.pending) : undefined}
      initialSignedRecovery={fixture.recovery} testFixture />
  </main>;
}
