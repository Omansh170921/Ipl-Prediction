import { useState, useEffect, useCallback } from 'react';
import { collection, getDocs, doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase/config';
import { formatDdMmYyyy } from '../utils/format';
import { to2Decimals, sumSeasonContestLeaderboardPoints } from '../utils/points';

function getTeamCode(team) {
  const code = (team?.code || '').trim();
  if (code) return code;
  return (team?.name || '').trim() || '';
}

function statusForRow(c, resp, lbEntry) {
  const scored = Boolean(
    resp?.scoredAt || lbEntry?.points != null || resp?.pointsAwarded != null
  );
  if (scored) return { label: 'Scored', kind: 'scored' };
  if (!c.acceptingPredictions) return { label: 'Closed', kind: 'closed' };
  return { label: 'Open', kind: 'open' };
}

/**
 * @param {'default' | 'embedded' | 'modal'} [variant] — layout. `embedded`: inside overview card. `modal`: title comes from modal chrome; refresh row only.
 * @param {boolean} [embedded] — deprecated; same as variant="embedded"
 */
export default function MyChallengePointsPanel({ user, teams = [], embedded = false, variant }) {
  const layout = variant || (embedded ? 'embedded' : 'default');
  const inModal = layout === 'modal';
  const isEmbedded = layout === 'embedded';

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fullUserLb, setFullUserLb] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const load = useCallback(async () => {
    if (!user?.uid) return;
    setLoading(true);
    try {
      const [ctxSnap, userSnap] = await Promise.all([
        getDocs(collection(db, 'prediction_contexts')),
        getDoc(doc(db, 'users', user.uid)),
      ]);
      const seasonContestLeaderboard = userSnap.exists()
        ? userSnap.data().seasonContestLeaderboard || {}
        : {};
      setFullUserLb(seasonContestLeaderboard);

      const list = ctxSnap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((c) => c.active === true)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

      const next = await Promise.all(
        list.map(async (c) => {
          const rs = await getDoc(doc(db, 'prediction_contexts', c.id, 'responses', user.uid));
          const resp = rs.exists() ? rs.data() : null;
          const lbEntry = seasonContestLeaderboard[c.id];
          const ptsRaw = lbEntry?.points ?? resp?.pointsAwarded;
          const points =
            ptsRaw != null && ptsRaw !== '' ? to2Decimals(Number(ptsRaw)) : null;
          const correct = resp?.correctCount;
          const status = statusForRow(c, resp, lbEntry);
          const scoredWhen = lbEntry?.scoredAt || lbEntry?.declaredAt || resp?.scoredAt;
          const winnerIds = Array.isArray(c.contestWinnerUserIds) ? c.contestWinnerUserIds : [];
          const winnersDeclared = winnerIds.length > 0;
          const userWon = user?.uid && winnerIds.includes(user.uid);
          const selectedTeamIds =
            resp && Array.isArray(resp.selectedTeamIds) ? [...resp.selectedTeamIds] : [];
          const officialEligibleTeamIds = Array.isArray(c.officialEligibleTeamIds)
            ? c.officialEligibleTeamIds
            : [];

          return {
            id: c.id,
            title: c.title || c.contextCode || c.id,
            points,
            correct: correct != null ? Number(correct) : null,
            participated: selectedTeamIds.length > 0,
            status,
            scoredWhen,
            winnersDeclared,
            userWon,
            winnersDeclaredAt: c.winnersDeclaredAt,
            selectedTeamIds,
            officialEligibleTeamIds,
          };
        })
      );
      setRows(next);
      setExpandedId(null);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  }, [user?.uid]);

  useEffect(() => {
    load();
  }, [load]);

  if (!user) return null;

  const Wrapper = layout === 'default' ? 'section' : 'div';
  const wrapperClass =
    layout === 'modal'
      ? 'challenge-points-in-modal'
      : isEmbedded
        ? 'challenge-points-embedded'
        : 'rules-section';
  const H = layout === 'default' ? 'h2' : 'h3';

  const titleBlock = !inModal && (
    <H className="section-heading challenge-points-heading">Challenge points</H>
  );

  if (loading) {
    return (
      <Wrapper className={wrapperClass}>
        {titleBlock}
        <p className="muted">Loading…</p>
      </Wrapper>
    );
  }

  if (rows.length === 0) {
    return (
      <Wrapper className={wrapperClass}>
        {titleBlock}
        <p className="muted">No active season challenges right now.</p>
      </Wrapper>
    );
  }

  const listSubtotal = rows.reduce((acc, r) => (r.points != null ? acc + r.points : acc), 0);
  const profileTotal =
    fullUserLb && typeof fullUserLb === 'object'
      ? sumSeasonContestLeaderboardPoints({ seasonContestLeaderboard: fullUserLb })
      : 0;

  return (
    <Wrapper className={wrapperClass}>
      {inModal ? (
        <div className="challenge-points-panel-header challenge-points-panel-header--refresh-only">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => load()}>
            Refresh
          </button>
        </div>
      ) : (
        <div className="challenge-points-panel-header">
          {titleBlock}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => load()}>
            Refresh
          </button>
        </div>
      )}
      <p className="muted">
        Your points per active season challenge (same values that feed the main leaderboard after an admin scores picks).
        Make or edit picks under <strong>Season predictions</strong>.{' '}
        <strong>Tap a challenge</strong> to see your predicted teams.
      </p>
      <ul className="challenge-points-list">
        {rows.map((r) => {
          const expanded = expandedId === r.id;
          const official = r.officialEligibleTeamIds || [];
          const hasOfficial = official.length > 0;
          return (
            <li
              key={r.id}
              className={`challenge-points-row ${expanded ? 'challenge-points-row--expanded' : ''}`}
            >
              <button
                type="button"
                className="challenge-points-row-summary"
                aria-expanded={expanded}
                aria-controls={`challenge-picks-${r.id}`}
                onClick={() => setExpandedId((id) => (id === r.id ? null : r.id))}
              >
                <span className="challenge-points-row-chevron" aria-hidden>
                  {expanded ? '▼' : '▶'}
                </span>
                <div className="challenge-points-row-summary-body">
                  <div className="challenge-points-row-main">
                    <span className="challenge-points-title">{r.title}</span>
                    <span
                      className={`challenge-points-status challenge-points-status--${r.status.kind}`}
                    >
                      {r.status.label}
                    </span>
                  </div>
                  <div className="challenge-points-row-meta">
                    <span className="challenge-points-points">
                      {r.points != null ? (
                        <strong className={r.points >= 0 ? 'points-positive' : 'points-negative'}>
                          {r.points} pts
                        </strong>
                      ) : (
                        <span className="muted">—</span>
                      )}
                      {r.correct != null && r.status.kind === 'scored' && (
                        <span className="muted"> · {r.correct} correct</span>
                      )}
                      {!r.participated && <span className="muted"> · No picks saved</span>}
                    </span>
                    {r.scoredWhen && (
                      <span className="muted challenge-points-date">
                        {formatDdMmYyyy(r.scoredWhen)}
                      </span>
                    )}
                  </div>
                  {r.winnersDeclared && (
                    <p
                      className="muted challenge-points-winners"
                      style={{ margin: '0.35rem 0 0 0', fontSize: '0.85rem' }}
                    >
                      Contest winners published
                      {r.winnersDeclaredAt ? ` · ${formatDdMmYyyy(r.winnersDeclaredAt)}` : ''}
                      {r.userWon && (
                        <span className="points-positive" style={{ fontWeight: 600 }}>
                          {' '}
                          — You are listed as a winner
                        </span>
                      )}
                    </p>
                  )}
                </div>
              </button>
              {expanded && (
                <div className="challenge-points-picks-detail" id={`challenge-picks-${r.id}`}>
                  {!r.participated ? (
                    <p className="muted" style={{ margin: 0 }}>
                      You have not saved picks for this challenge. Open{' '}
                      <strong>Season predictions</strong> to choose teams.
                    </p>
                  ) : (
                    <>
                      <p className="challenge-points-picks-heading">Your predicted teams</p>
                      <ul className="challenge-points-picks-list">
                        {r.selectedTeamIds.map((teamId) => {
                          const t = teams.find((x) => x.id === teamId);
                          const label = t ? getTeamCode(t) || `Team id: ${teamId}` : `Team id: ${teamId}`;
                          const isCorrect = hasOfficial && official.includes(teamId);
                          const isWrong = hasOfficial && !official.includes(teamId);
                          return (
                            <li
                              key={teamId}
                              className={
                                'challenge-points-pick-row' +
                                (isCorrect ? ' challenge-points-pick-row--correct' : '') +
                                (isWrong ? ' challenge-points-pick-row--wrong' : '')
                              }
                            >
                              <span>{label}</span>
                              {hasOfficial && (
                                <span
                                  className="challenge-points-pick-mark"
                                  aria-label={isCorrect ? 'Correct pick' : 'Incorrect pick'}
                                >
                                  {isCorrect ? '✓' : '✗'}
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                      {hasOfficial && (
                        <p className="muted challenge-points-picks-note" style={{ margin: '0.5rem 0 0 0', fontSize: '0.82rem' }}>
                          ✓ = matched official result for this challenge. Compare with{' '}
                          <strong>Season predictions</strong> for full context.
                        </p>
                      )}
                      {!hasOfficial && r.status.kind !== 'open' && (
                        <p className="muted challenge-points-picks-note" style={{ margin: '0.5rem 0 0 0', fontSize: '0.82rem' }}>
                          Official result not published yet; picks are shown without right/wrong marks.
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="challenge-points-footer muted">
        <p style={{ margin: '0.75rem 0 0 0' }}>
          Subtotal (challenges above): <strong>{to2Decimals(listSubtotal)}</strong> pts
          {profileTotal !== listSubtotal && (
            <>
              {' '}
              · All scored challenges on your profile: <strong>{to2Decimals(profileTotal)}</strong> pts
            </>
          )}
        </p>
      </div>
    </Wrapper>
  );
}
