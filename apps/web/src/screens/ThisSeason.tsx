import { Screen } from '../components/ui.js';

/** This Season — dubs landing this week — arrives in Phase 3 (KURO-REQ-036). */
export function ThisSeason() {
  return (
    <Screen kicker="Dubs this week" title="This Season">
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <p className="font-display text-[40px] text-faint">季</p>
        <p className="text-[18px] font-bold">Coming soon</p>
        <p className="text-[15px] text-muted">This week’s dubs, with the shows you’re watching first, arrive in a later update.</p>
      </div>
    </Screen>
  );
}
