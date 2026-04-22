import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { collection, getDocs, doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../firebase/config';
import {
  countCorrectPicks,
  pointsForCorrectPredictions,
  normalizeContextTiers,
  isContextDeadlinePassed,
} from '../utils/predictionContext';
import { formatContextDeadlineDisplay } from '../utils/format';
import { formatDdMmYyyy, toInitCap } from '../utils/format';
import { getPredictionSavedIso, formatTimeHH24 } from '../utils/predictionTime';
import { to2Decimals } from '../utils/points';

function getTeamLabel(team) {
  const code = (team?.code || '').trim();
  const name = team?.name || '';
  return code ? `${name} (${code})` : name || '';
}

function getTeamCodeOnly(team) {
  if (!team) return '—';
  const code = (team.code || '').trim();
  if (code) return code;
  return (team.name || '').trim() || '—';
}

function formatParticipatedAt(iso) {
  if (!iso) return '—';
  const date = formatDdMmYyyy(iso);
  const time = formatTimeHH24(iso);
  if (!date && time === '—') return '—';
  return time === '—' ? date : `${date} · ${time}`;
}

export default function PredictionContextsUserPanel({ user, teams }) {
  const [contexts, setContexts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  /** contextId -> selected team ids (local edit state) */
  const [picks, setPicks] = useState({});
  /** contextId -> loaded response meta */
  const [meta, setMeta] = useState({});
  /** contextId -> { rows: { userId, displayName, selectedTeamIds, participatedAtIso, pointsEarned }[], error? } — all active challenges */
  const [participantsByContext, setParticipantsByContext] = useState({});
  /** Season challenge whose participant list is open in a modal (same pattern as match participants). */
  const [seasonParticipantsModalContext, setSeasonParticipantsModalContext] = useState(null);

  const load = useCallback(async () => {
    if (!user?.uid) return;
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, 'prediction_contexts'));
      const list = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((c) => c.active === true)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      setContexts(list);
      const nextPicks = {};
      const nextMeta = {};
      for (const c of list) {
        const ref = doc(db, 'prediction_contexts', c.id, 'responses', user.uid);
        const rs = await getDoc(ref);
        if (rs.exists()) {
          const d = rs.data();
          nextPicks[c.id] = Array.isArray(d.selectedTeamIds) ? [...d.selectedTeamIds] : [];
          nextMeta[c.id] = {
            pointsAwarded: d.pointsAwarded,
            correctCount: d.correctCount,
            scoredAt: d.scoredAt,
          };
        } else {
          nextPicks[c.id] = [];
          nextMeta[c.id] = {};
        }
      }
      setPicks(nextPicks);
      setMeta(nextMeta);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  }, [user?.uid]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    if (!user?.uid || contexts.length === 0) {
      setParticipantsByContext({});
      return () => {
        cancelled = true;
      };
    }
    (async () => {
      try {
        const usersSnap = await getDocs(collection(db, 'users'));
        if (cancelled) return;
        const idToDisplay = {};
        usersSnap.docs.forEach((d) => {
          const u = d.data();
          if (u.isAdmin === true || u.isAdmin === 'true' || u.isAdmin === 1) return;
          const raw = (u.username || u.email || '').toString();
          idToDisplay[d.id] = toInitCap(raw.replace(/_/g, ' ').trim()) || d.id;
        });
        const merged = {};
        await Promise.all(
          contexts.map(async (c) => {
            try {
              const respSnap = await getDocs(collection(db, 'prediction_contexts', c.id, 'responses'));
              if (cancelled) return;
              const rows = respSnap.docs
                .map((docSnap) => {
                  const data = docSnap.data();
                  const uid = docSnap.id;
                  const selectedTeamIds = Array.isArray(data.selectedTeamIds) ? [...data.selectedTeamIds] : [];
                  const participatedAtIso = getPredictionSavedIso(data);
                  const rawPts = data.pointsAwarded;
                  const pointsEarned =
                    rawPts != null && rawPts !== '' && !Number.isNaN(Number(rawPts))
                      ? to2Decimals(Number(rawPts))
                      : null;
                  return {
                    userId: uid,
                    displayName: idToDisplay[uid] || `User ${uid.slice(0, 8)}…`,
                    selectedTeamIds,
                    participatedAtIso,
                    pointsEarned,
                  };
                })
                .filter((r) => r.selectedTeamIds.length > 0)
                .sort((a, b) =>
                  a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
                );
              merged[c.id] = { rows };
            } catch (err) {
              console.error(err);
              merged[c.id] = {
                rows: [],
                error: err?.message || 'Could not load participants',
              };
            }
          })
        );
        if (!cancelled) setParticipantsByContext(merged);
      } catch (e) {
        console.error(e);
        if (!cancelled) {
          const err = {};
          contexts.forEach((c) => {
            err[c.id] = { rows: [], error: e?.message || 'Failed to load' };
          });
          setParticipantsByContext(err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contexts, user?.uid]);

  const togglePick = (contextId, teamId, maxSelections, eligibleIds) => {
    const c = contexts.find((x) => x.id === contextId);
    if (!c?.acceptingPredictions) return;
    if (isContextDeadlinePassed(c.deadline)) return;
    if (!eligibleIds.includes(teamId)) return;
    setPicks((prev) => {
      const cur = [...(prev[contextId] || [])];
      const i = cur.indexOf(teamId);
      if (i >= 0) cur.splice(i, 1);
      else if (cur.length < maxSelections) cur.push(teamId);
      return { ...prev, [contextId]: cur };
    });
  };

  const savePicks = async (c) => {
    if (!user?.uid || !c.acceptingPredictions) return;
    if (isContextDeadlinePassed(c.deadline)) return;
    const selected = picks[c.id] || [];
    const max = Math.max(1, parseInt(c.maxSelections, 10) || 4);
    if (selected.length !== max) {
      alert(`Select exactly ${max} team(s).`);
      return;
    }
    setSavingId(c.id);
    try {
      await setDoc(
        doc(db, 'prediction_contexts', c.id, 'responses', user.uid),
        {
          userId: user.uid,
          selectedTeamIds: selected,
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
      await load();
    } catch (e) {
      alert(e.message || 'Failed to save');
    }
    setSavingId(null);
  };

  if (!user) return null;
  if (loading) return <p className="muted">Loading…</p>;

  if (contexts.length === 0) {
    return (
      <section className="rules-section">
        <h2 className="section-heading">Season predictions</h2>
        <p className="muted">No open prediction challenges right now.</p>
      </section>
    );
  }

  return (
    <section className="rules-section">
      <h2 className="section-heading">Season predictions</h2>
      <p className="muted">
        Pick the teams you think will qualify (e.g. quarter-finals). Points depend on how many of your picks match the official result, using the tiers shown on each card.
      </p>
      <div className="matches-grid" style={{ marginTop: '1rem' }}>
        {contexts.map((c) => {
          const eligible = teams.filter((t) => (c.eligibleTeamIds || []).includes(t.id));
          const max = Math.max(1, parseInt(c.maxSelections, 10) || 4);
          const selected = picks[c.id] || [];
          const m = meta[c.id] || {};
          const closed = !c.acceptingPredictions;
          const deadlinePass = isContextDeadlinePassed(c.deadline);
          const canChangePicks = c.acceptingPredictions && !deadlinePass;
          const official = Array.isArray(c.officialEligibleTeamIds) ? c.officialEligibleTeamIds : [];
          const previewCorrect =
            closed && official.length > 0 ? countCorrectPicks(selected, official) : null;
          const previewPts =
            previewCorrect != null ? pointsForCorrectPredictions(previewCorrect, c.tiers) : null;
          const winnerIds = Array.isArray(c.contestWinnerUserIds) ? c.contestWinnerUserIds : [];
          const winnersDeclared = winnerIds.length > 0;
          const userWon = user?.uid && winnerIds.includes(user.uid);
          const participantsModalOpen = seasonParticipantsModalContext?.id === c.id;
          const pdata = participantsByContext[c.id];

          return (
            <div key={c.id} className="match-card">
              <div className="match-card-icons match-card-icons--season-participants">
                <button
                  type="button"
                  className={`btn btn-sm btn-outline btn-icon-only btn-season-participants ${participantsModalOpen ? 'active' : ''}`}
                  onClick={() => setSeasonParticipantsModalContext(c)}
                  title="View participants (username and prediction time; team picks stay private)"
                  aria-label="View season challenge participants"
                  aria-expanded={participantsModalOpen}
                  aria-haspopup="dialog"
                >
                  <span className="season-participants-btn-icon" aria-hidden="true">
                    👥
                  </span>
                </button>
              </div>
              <p className="muted season-challenge-participant-count" style={{ fontSize: '0.88rem', margin: '0 0 0.35rem 0' }}>
                {pdata === undefined && (
                  <>
                    Participants: <strong>…</strong>
                  </>
                )}
                {pdata && pdata.error && (
                  <>
                    Participants: <strong>—</strong>
                  </>
                )}
                {pdata && !pdata.error && (
                  <>
                    <strong>{pdata.rows.length}</strong> participant{pdata.rows.length === 1 ? '' : 's'} with saved picks
                  </>
                )}
              </p>
              <h3 style={{ marginTop: 0 }}>{c.title}</h3>
              {c.description && <p className="muted">{c.description}</p>}
              <p className="muted" style={{ fontSize: '0.9rem' }}>
                Pick exactly <strong>{max}</strong> team(s).
                {c.deadline && (
                  <span className="prediction-context-deadline">
                    {' '}
                    Deadline: <strong>{formatContextDeadlineDisplay(c.deadline)}</strong>
                  </span>
                )}
              </p>
              <p className="muted prediction-context-points-tiers" style={{ fontSize: '0.85rem' }}>
                Points:{' '}
                {normalizeContextTiers(c.tiers)
                  .map((t) => `${t.correctCount} right → ${t.points} pts`)
                  .join(' · ') || '—'}
              </p>
              {deadlinePass && c.acceptingPredictions && (
                <p className="prediction-closed" style={{ fontSize: '0.9rem' }}>
                  Deadline has passed. You can no longer change your picks for this challenge.
                </p>
              )}
              <div className="filter-tags" style={{ marginTop: '0.75rem' }}>
                {eligible.map((t) => {
                  const on = selected.includes(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className={`filter-tag ${on ? 'active' : ''}`}
                      disabled={!canChangePicks}
                      onClick={() => togglePick(c.id, t.id, max, c.eligibleTeamIds || [])}
                    >
                      {getTeamLabel(t)}
                    </button>
                  );
                })}
              </div>
              <p style={{ marginTop: '0.75rem', fontSize: '0.9rem' }}>
                Selected: {selected.length} / {max}
              </p>
              {canChangePicks && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  style={{ marginTop: '0.5rem' }}
                  disabled={savingId === c.id || selected.length !== max}
                  onClick={() => savePicks(c)}
                >
                  {savingId === c.id ? 'Saving…' : 'Save picks'}
                </button>
              )}
              {closed && official.length > 0 && (
                <p className="muted" style={{ marginTop: '0.65rem', fontSize: '0.88rem' }}>
                  <strong>Official result (this challenge):</strong>{' '}
                  {official
                    .map((tid) => getTeamCodeOnly(teams.find((t) => t.id === tid)))
                    .filter(Boolean)
                    .join(', ') || '—'}
                </p>
              )}
              {(m.scoredAt || closed) && (
                <div style={{ marginTop: '0.75rem', padding: '0.75rem', background: '#f5f5f5', borderRadius: 8 }}>
                  {m.pointsAwarded != null && m.correctCount != null ? (
                    <>
                      <p style={{ margin: 0 }}>
                        Your result: <strong>{m.correctCount}</strong> correct →{' '}
                        <strong className="points-positive">{m.pointsAwarded}</strong> points
                      </p>
                      {m.scoredAt && (
                        <p className="muted" style={{ margin: '0.35rem 0 0 0', fontSize: '0.85rem' }}>
                          Scored {m.scoredAt}
                        </p>
                      )}
                    </>
                  ) : closed && previewCorrect != null ? (
                    <p style={{ margin: 0 }}>
                      Official teams are set. Your picks: <strong>{previewCorrect}</strong> correct →{' '}
                      <strong>{previewPts}</strong> pts (pending admin scoring if not saved yet)
                    </p>
                  ) : (
                    <p className="muted" style={{ margin: 0 }}>Results will appear after the admin scores this challenge.</p>
                  )}
                </div>
              )}
              {winnersDeclared && (
                <div
                  style={{
                    marginTop: '0.75rem',
                    padding: '0.75rem',
                    borderRadius: 8,
                    border: userWon ? '2px solid var(--accent, #2563eb)' : '1px solid var(--border)',
                    background: userWon ? 'rgba(37, 99, 235, 0.08)' : '#fafafa',
                  }}
                >
                  <p style={{ margin: 0, fontWeight: 600 }}>Contest winners</p>
                  <p style={{ margin: '0.35rem 0 0 0' }}>
                    {(c.contestWinnerDisplayNames || winnerIds).join(', ')}
                    {c.contestWinningPoints != null && (
                      <span className="muted">
                        {' '}
                        — {c.contestWinningPoints} pts{winnerIds.length > 1 ? ' each' : ''}
                      </span>
                    )}
                  </p>
                  {c.winnersDeclaredAt && (
                    <p className="muted" style={{ margin: '0.35rem 0 0 0', fontSize: '0.85rem' }}>
                      Declared {formatDdMmYyyy(c.winnersDeclaredAt)}
                    </p>
                  )}
                  {userWon && (
                    <p className="points-positive" style={{ margin: '0.5rem 0 0 0', fontWeight: 600 }}>
                      You are listed as a contest winner for this challenge.
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {seasonParticipantsModalContext &&
        createPortal(
          (() => {
            const mc = seasonParticipantsModalContext;
            const mpdata = participantsByContext[mc.id];
            const closeModal = () => setSeasonParticipantsModalContext(null);
            const deadlinePassModal = isContextDeadlinePassed(mc.deadline);
            const closedModal = !mc.acceptingPredictions;
            const revealPicks = closedModal || deadlinePassModal;
            return (
              <div className="modal-overlay" onClick={closeModal}>
                <div
                  className={`modal-content participants-modal participants-modal--season-challenge${revealPicks ? ' participants-modal--season-picks-visible' : ''}`}
                  onClick={(e) => e.stopPropagation()}
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="season-participants-modal-title"
                >
                  <div className="modal-header season-participants-modal-header">
                    <div className="season-participants-modal-header-text">
                      <h3 id="season-participants-modal-title">Participants — {mc.title || 'Season challenge'}</h3>
                      <p className="muted season-participants-modal-count" style={{ margin: '0.35rem 0 0 0', fontSize: '0.9rem' }}>
                        {mpdata === undefined && (
                          <>
                            Total: <strong>…</strong>
                          </>
                        )}
                        {mpdata && mpdata.error && <>Total: <strong>—</strong></>}
                        {mpdata && !mpdata.error && (
                          <>
                            <strong>{mpdata.rows.length}</strong> participant{mpdata.rows.length === 1 ? '' : 's'} with saved picks
                          </>
                        )}
                      </p>
                    </div>
                    <button type="button" className="modal-close" onClick={closeModal} aria-label="Close">
                      &times;
                    </button>
                  </div>
                  <p className="muted participants-points-note" style={{ marginTop: 0 }}>
                    {revealPicks ? (
                      <>
                        The pick deadline has passed or this challenge is closed. Everyone&apos;s saved team picks are shown
                        below with username and when they last saved.
                      </>
                    ) : (
                      <>
                        Everyone who has saved picks is listed below with username and time. Team choices stay hidden until
                        the deadline passes or an admin stops accepting predictions for this challenge.
                      </>
                    )}
                  </p>
                  {!mpdata ? (
                    <p className="muted">Loading participants…</p>
                  ) : mpdata.error ? (
                    <p className="alert alert-error" role="alert">
                      {mpdata.error}
                    </p>
                  ) : mpdata.rows.length === 0 ? (
                    <p className="muted">No saved picks for this challenge.</p>
                  ) : (
                    <ul className="participants-list">
                      <li className={`participants-list-header ${revealPicks ? 'cols-3' : 'cols-2'}`}>
                        <span>Username</span>
                        {revealPicks ? <span className="col-season-picks">Picks (teams)</span> : null}
                        <span className="col-predicted-at">Predicted at</span>
                      </li>
                      {mpdata.rows.map((row, i) => {
                        const atLabel = formatParticipatedAt(row.participatedAtIso);
                        const codes = revealPicks
                          ? row.selectedTeamIds
                              .map((tid) => getTeamCodeOnly(teams.find((t) => t.id === tid)))
                              .filter(Boolean)
                              .join(', ')
                          : '';
                        return (
                          <li key={row.userId || i} className={`participant-item ${revealPicks ? 'cols-3' : 'cols-2'}`}>
                            <span className="participant-name">{row.displayName}</span>
                            {revealPicks ? (
                              <span className="participant-prediction participant-picks-codes" title={codes || undefined}>
                                {codes || '—'}
                              </span>
                            ) : null}
                            <span
                              className="participant-predicted-at participant-participated-at"
                              title={row.participatedAtIso || undefined}
                            >
                              {atLabel}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>
            );
          })(),
          document.body
        )}
    </section>
  );
}
