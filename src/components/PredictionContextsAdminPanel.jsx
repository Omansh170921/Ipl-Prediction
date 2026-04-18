import { useState, useEffect, useCallback, useRef } from 'react';
import {
  collection,
  getDocs,
  getDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  writeBatch,
  deleteField,
  Timestamp,
} from 'firebase/firestore';
import { db } from '../firebase/config';
import {
  normalizeContextTiers,
  pointsForCorrectPredictions,
  countCorrectPicks,
  computeContestWinnerUserIds,
  generateContextCode,
  DEFAULT_CONTEXT_TIERS,
  deadlineToDatetimeLocalValue,
  deadlineStringToMillis,
} from '../utils/predictionContext';
import { formatInsightUserLabel } from '../utils/insightQuestions';
import { formatDdMmYyyy, formatContextDeadlineDisplay } from '../utils/format';
import { to2Decimals } from '../utils/points';

function getTeamLabel(team) {
  const code = (team?.code || '').trim();
  const name = team?.name || '';
  return code ? `${name} (${code})` : name || team?.id || '';
}

export default function PredictionContextsAdminPanel({ teams, allUsers = [], setMessage }) {
  const [contexts, setContexts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [scoringId, setScoringId] = useState(null);
  const [declaringWinnersId, setDeclaringWinnersId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [formTitle, setFormTitle] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formMaxSelections, setFormMaxSelections] = useState(4);
  const [formDeadline, setFormDeadline] = useState('');
  const [formEligibleIds, setFormEligibleIds] = useState([]);
  const [formTiers, setFormTiers] = useState(() => DEFAULT_CONTEXT_TIERS.map((t) => ({ ...t })));
  /** Correct answer while editing/creating (subset of form eligible ids) */
  const [formOfficialIds, setFormOfficialIds] = useState([]);
  const [officialSelections, setOfficialSelections] = useState({});
  const formAnchorRef = useRef(null);

  const loadContexts = useCallback(async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, 'prediction_contexts'));
      let list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const needsDeadlineAt = list.filter((c) => {
        const has = c.deadline != null && String(c.deadline).trim() !== '';
        return has && !c.deadlineAt;
      });
      if (needsDeadlineAt.length > 0) {
        const batch = writeBatch(db);
        let syncCount = 0;
        for (const c of needsDeadlineAt) {
          const ms = deadlineStringToMillis(c.deadline);
          if (ms == null) continue;
          batch.update(doc(db, 'prediction_contexts', c.id), {
            deadlineAt: Timestamp.fromMillis(ms),
            updatedAt: new Date().toISOString(),
          });
          syncCount += 1;
        }
        if (syncCount > 0) {
          await batch.commit();
          const snap2 = await getDocs(collection(db, 'prediction_contexts'));
          list = snap2.docs.map((d) => ({ id: d.id, ...d.data() }));
          setMessage(
            `Synced ${syncCount} challenge deadline(s) for participant visibility (Firestore rules).`
          );
        }
      }
      list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      setContexts(list);
      const off = {};
      list.forEach((c) => {
        off[c.id] = Array.isArray(c.officialEligibleTeamIds) ? [...c.officialEligibleTeamIds] : [];
      });
      setOfficialSelections(off);
    } catch (e) {
      setMessage('Error loading prediction contexts: ' + (e.message || ''));
    }
    setLoading(false);
  }, [setMessage]);

  useEffect(() => {
    loadContexts();
  }, [loadContexts]);

  useEffect(() => {
    if (formOpen && formAnchorRef.current) {
      formAnchorRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [formOpen]);

  const resetForm = () => {
    setEditingId(null);
    setFormTitle('');
    setFormDescription('');
    setFormMaxSelections(4);
    setFormDeadline('');
    setFormEligibleIds([]);
    setFormOfficialIds([]);
    setFormTiers(DEFAULT_CONTEXT_TIERS.map((t) => ({ ...t })));
  };

  const openCreate = () => {
    resetForm();
    setFormOpen(true);
  };

  const openEdit = (c) => {
    setEditingId(c.id);
    setFormTitle(c.title || '');
    setFormDescription(c.description || '');
    setFormMaxSelections(Math.max(1, parseInt(c.maxSelections, 10) || 4));
    setFormDeadline(deadlineToDatetimeLocalValue(c.deadline) || '');
    setFormEligibleIds(Array.isArray(c.eligibleTeamIds) ? [...c.eligibleTeamIds] : []);
    setFormOfficialIds(Array.isArray(c.officialEligibleTeamIds) ? [...c.officialEligibleTeamIds] : []);
    const t = Array.isArray(c.tiers) && c.tiers.length > 0 ? c.tiers : DEFAULT_CONTEXT_TIERS;
    setFormTiers(t.map((x) => ({ correctCount: x.correctCount, points: x.points })));
    setFormOpen(true);
  };

  const toggleEligibleTeam = (teamId) => {
    setFormEligibleIds((prev) => {
      if (prev.includes(teamId)) {
        setFormOfficialIds((o) => o.filter((id) => id !== teamId));
        return prev.filter((id) => id !== teamId);
      }
      return [...prev, teamId];
    });
  };

  const toggleFormOfficialTeam = (teamId) => {
    const maxSel = Math.max(1, Math.min(20, parseInt(formMaxSelections, 10) || 4));
    setFormOfficialIds((prev) => {
      if (prev.includes(teamId)) return prev.filter((id) => id !== teamId);
      if (prev.length >= maxSel) return prev;
      return [...prev, teamId];
    });
  };

  const updateTierRow = (index, field, value) => {
    setFormTiers((prev) => {
      const next = prev.map((row, i) => (i === index ? { ...row, [field]: value } : row));
      return next;
    });
  };

  const addTierRow = () => {
    setFormTiers((prev) => [...prev, { correctCount: 0, points: 0 }]);
  };

  const removeTierRow = (index) => {
    setFormTiers((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSaveContext = async (e) => {
    e.preventDefault();
    const title = formTitle.trim();
    if (!title) {
      setMessage('Please enter a title.');
      return;
    }
    if (formEligibleIds.length < Math.max(1, formMaxSelections)) {
      setMessage(`Select at least as many eligible teams as max picks (${formMaxSelections}).`);
      return;
    }
    const tiers = normalizeContextTiers(formTiers);
    if (tiers.length === 0) {
      setMessage('Add at least one points tier (correct picks → points).');
      return;
    }
    const maxSel = Math.max(1, Math.min(20, parseInt(formMaxSelections, 10) || 4));
    const officialFiltered = formOfficialIds.filter((id) => formEligibleIds.includes(id));
    if (officialFiltered.length > 0 && officialFiltered.length !== maxSel) {
      setMessage(
        `Correct answer must include exactly ${maxSel} team(s) (same as picks per user), or leave all unchecked to clear. Currently ${officialFiltered.length} selected.`
      );
      return;
    }

    const payload = {
      title,
      description: (formDescription || '').trim() || null,
      maxSelections: maxSel,
      eligibleTeamIds: formEligibleIds,
      tiers,
      updatedAt: new Date().toISOString(),
    };
    if (formDeadline && String(formDeadline).trim()) {
      const raw = String(formDeadline).trim();
      payload.deadline = raw;
      const ms = deadlineStringToMillis(raw);
      payload.deadlineAt = ms == null ? deleteField() : Timestamp.fromMillis(ms);
    } else {
      payload.deadline = null;
      payload.deadlineAt = deleteField();
    }

    setSaving(true);
    try {
      if (editingId) {
        const existing = contexts.find((x) => x.id === editingId);
        if (existing && !existing.contextCode) {
          payload.contextCode = generateContextCode(title);
        }
        payload.officialEligibleTeamIds = officialFiltered;
        await updateDoc(doc(db, 'prediction_contexts', editingId), payload);
        setMessage(
          officialFiltered.length > 0
            ? 'Challenge and correct answer updated.'
            : 'Challenge updated (correct answer cleared).'
        );
      } else {
        await addDoc(collection(db, 'prediction_contexts'), {
          ...payload,
          contextCode: generateContextCode(title),
          active: true,
          acceptingPredictions: true,
          officialEligibleTeamIds: officialFiltered,
          createdAt: new Date().toISOString(),
        });
        setMessage(
          officialFiltered.length > 0
            ? 'Challenge created with a public code and correct answer set.'
            : 'Challenge created with a public code.'
        );
      }
      setFormOpen(false);
      resetForm();
      await loadContexts();
    } catch (err) {
      setMessage('Error saving: ' + (err.message || ''));
    }
    setSaving(false);
  };

  const setOfficialForContext = async (contextId, c) => {
    const ids = officialSelections[contextId] || [];
    const maxSel = Math.max(1, parseInt(c.maxSelections, 10) || 4);
    if (ids.length > 0 && ids.length !== maxSel) {
      setMessage(`Correct answer must be exactly ${maxSel} team(s) (or clear all selections).`);
      return;
    }
    setSaving(true);
    try {
      await updateDoc(doc(db, 'prediction_contexts', contextId), {
        officialEligibleTeamIds: ids,
        updatedAt: new Date().toISOString(),
      });
      setMessage('Correct answer saved. Run “Score all submissions” when ready.');
      await loadContexts();
    } catch (err) {
      setMessage('Error: ' + (err.message || ''));
    }
    setSaving(false);
  };

  const toggleOfficialTeam = (contextId, teamId, maxSelections) => {
    const maxSel = Math.max(1, parseInt(maxSelections, 10) || 4);
    setOfficialSelections((prev) => {
      const cur = [...(prev[contextId] || [])];
      const i = cur.indexOf(teamId);
      if (i >= 0) cur.splice(i, 1);
      else if (cur.length < maxSel) cur.push(teamId);
      return { ...prev, [contextId]: cur };
    });
  };

  const handleScoreContext = async (c) => {
    const official = Array.isArray(c.officialEligibleTeamIds) ? c.officialEligibleTeamIds : [];
    if (official.length === 0) {
      setMessage('Set official qualifying teams first, then save.');
      return;
    }
    if (
      !window.confirm(
        `Score all submissions for “${c.title}”? Each player’s points (from correct picks and your points table) will be saved on their submission and added to their main leaderboard. Predictions will close.`
      )
    )
      return;
    setScoringId(c.id);
    try {
      const respSnap = await getDocs(collection(db, 'prediction_contexts', c.id, 'responses'));
      const userPayloads = [];
      let batch = writeBatch(db);
      let inBatch = 0;
      const now = new Date().toISOString();
      for (const d of respSnap.docs) {
        const data = d.data();
        const selected = Array.isArray(data.selectedTeamIds) ? data.selectedTeamIds : [];
        const correct = countCorrectPicks(selected, official);
        const pts = to2Decimals(Number(pointsForCorrectPredictions(correct, c.tiers)));
        batch.update(d.ref, {
          correctCount: correct,
          pointsAwarded: pts,
          scoredAt: now,
        });
        inBatch += 1;
        userPayloads.push({ uid: d.id, pts });
        if (inBatch >= 400) {
          await batch.commit();
          batch = writeBatch(db);
          inBatch = 0;
        }
      }
      if (inBatch > 0) await batch.commit();

      const userSnaps = await Promise.all(userPayloads.map(({ uid }) => getDoc(doc(db, 'users', uid))));
      let userBatch = writeBatch(db);
      let userOps = 0;
      for (let i = 0; i < userPayloads.length; i++) {
        if (!userSnaps[i].exists()) continue;
        const { uid, pts } = userPayloads[i];
        userBatch.update(doc(db, 'users', uid), {
          [`seasonContestLeaderboard.${c.id}`]: {
            contextCode: c.contextCode || c.id,
            title: c.title || '',
            points: pts,
            scoredAt: now,
          },
        });
        userOps += 1;
        if (userOps >= 400) {
          await userBatch.commit();
          userBatch = writeBatch(db);
          userOps = 0;
        }
      }
      if (userOps > 0) await userBatch.commit();

      await updateDoc(doc(db, 'prediction_contexts', c.id), {
        acceptingPredictions: false,
        lastScoredAt: now,
        updatedAt: now,
      });
      setMessage(
        `Scored ${respSnap.size} response(s). Points are on each profile’s main leaderboard. Predictions are closed for this challenge.`
      );
      await loadContexts();
    } catch (err) {
      setMessage('Error scoring: ' + (err.message || ''));
    }
    setScoringId(null);
  };

  const handleReopenPredictions = async (c) => {
    if (
      !window.confirm(
        `Re-open predictions for “${c.title}”? Saved scores and leaderboard points for this challenge will be cleared until you run “Score all” again. Published winners will be cleared too.`
      )
    )
      return;
    setSaving(true);
    try {
      const respSnap = await getDocs(collection(db, 'prediction_contexts', c.id, 'responses'));
      const uids = respSnap.docs.map((d) => d.id);

      let rb = writeBatch(db);
      let rn = 0;
      for (const d of respSnap.docs) {
        rb.update(d.ref, {
          correctCount: deleteField(),
          pointsAwarded: deleteField(),
          scoredAt: deleteField(),
        });
        rn += 1;
        if (rn >= 400) {
          await rb.commit();
          rb = writeBatch(db);
          rn = 0;
        }
      }
      if (rn > 0) await rb.commit();

      const userSnaps = await Promise.all(uids.map((uid) => getDoc(doc(db, 'users', uid))));
      let ub = writeBatch(db);
      let un = 0;
      for (let i = 0; i < uids.length; i++) {
        if (!userSnaps[i].exists()) continue;
        ub.update(doc(db, 'users', uids[i]), { [`seasonContestLeaderboard.${c.id}`]: deleteField() });
        un += 1;
        if (un >= 400) {
          await ub.commit();
          ub = writeBatch(db);
          un = 0;
        }
      }
      if (un > 0) await ub.commit();

      const now = new Date().toISOString();
      await updateDoc(doc(db, 'prediction_contexts', c.id), {
        acceptingPredictions: true,
        lastScoredAt: deleteField(),
        contestWinnerUserIds: deleteField(),
        contestWinnerDisplayNames: deleteField(),
        contestWinningPoints: deleteField(),
        winnersDeclaredAt: deleteField(),
        leaderboardBonusPerWinner: deleteField(),
        updatedAt: now,
      });
      setMessage('Predictions re-opened. Scores, leaderboard points for this challenge, and winner list were reset. Run “Score all” when ready.');
      await loadContexts();
    } catch (err) {
      setMessage('Error: ' + (err.message || ''));
    }
    setSaving(false);
  };

  const handleDeleteContext = async (c) => {
    if (!window.confirm(`Delete “${c.title}” and all user responses? Leaderboard points from this challenge will be removed from users. This cannot be undone.`)) return;
    setSaving(true);
    try {
      const respSnap = await getDocs(collection(db, 'prediction_contexts', c.id, 'responses'));
      const responseUserIds = respSnap.docs.map((d) => d.id);
      let batch = writeBatch(db);
      let count = 0;
      for (const d of respSnap.docs) {
        batch.delete(d.ref);
        count += 1;
        if (count % 400 === 0) {
          await batch.commit();
          batch = writeBatch(db);
        }
      }
      await batch.commit();

      const userSnaps = await Promise.all(responseUserIds.map((uid) => getDoc(doc(db, 'users', uid))));
      let ub = writeBatch(db);
      let uo = 0;
      for (let i = 0; i < responseUserIds.length; i++) {
        if (!userSnaps[i].exists()) continue;
        ub.update(doc(db, 'users', responseUserIds[i]), { [`seasonContestLeaderboard.${c.id}`]: deleteField() });
        uo += 1;
        if (uo >= 400) {
          await ub.commit();
          ub = writeBatch(db);
          uo = 0;
        }
      }
      if (uo > 0) await ub.commit();

      await deleteDoc(doc(db, 'prediction_contexts', c.id));
      setMessage('Challenge deleted; related leaderboard entries removed from users.');
      await loadContexts();
    } catch (err) {
      setMessage('Error deleting: ' + (err.message || ''));
    }
    setSaving(false);
  };

  const handleToggleActive = async (c, active) => {
    setSaving(true);
    try {
      await updateDoc(doc(db, 'prediction_contexts', c.id), {
        active,
        updatedAt: new Date().toISOString(),
      });
      setMessage(active ? 'Context is visible to users.' : 'Context hidden from users.');
      await loadContexts();
    } catch (err) {
      setMessage('Error: ' + (err.message || ''));
    }
    setSaving(false);
  };

  /** Everyone tied for the highest contest points (after scoring) is listed as winners (Season predictions UI only). Leaderboard points come from scoring. */
  const handleDeclareContestWinners = async (c) => {
    if (
      !window.confirm(
        `Declare contest winners for “${c.title}”? Everyone tied for the top score will be shown to players on Season predictions. Their leaderboard points were already set when you ran “Score all”.`
      )
    )
      return;
    setDeclaringWinnersId(c.id);
    try {
      const respSnap = await getDocs(collection(db, 'prediction_contexts', c.id, 'responses'));
      const entries = [];
      respSnap.docs.forEach((d) => {
        const data = d.data();
        if (data.pointsAwarded == null) return;
        const pts = Number(data.pointsAwarded);
        if (Number.isNaN(pts)) return;
        entries.push({ userId: d.id, pointsAwarded: pts });
      });
      const result = computeContestWinnerUserIds(entries);
      if (!result || result.winnerUserIds.length === 0) {
        setMessage('No scored submissions found. Run “Score all submissions” first.');
        setDeclaringWinnersId(null);
        return;
      }
      const now = new Date().toISOString();
      const contestWinnerDisplayNames = result.winnerUserIds.map((uid) => formatInsightUserLabel(allUsers, uid));
      await updateDoc(doc(db, 'prediction_contexts', c.id), {
        contestWinnerUserIds: result.winnerUserIds,
        contestWinnerDisplayNames,
        contestWinningPoints: result.winningPoints,
        winnersDeclaredAt: now,
        leaderboardBonusPerWinner: deleteField(),
        updatedAt: now,
      });
      setMessage(
        `Winners published: ${contestWinnerDisplayNames.join(', ')} (top score ${result.winningPoints} pts${result.winnerUserIds.length > 1 ? ' each' : ''}). Leaderboard totals unchanged.`
      );
      await loadContexts();
    } catch (err) {
      setMessage('Error declaring winners: ' + (err.message || ''));
    }
    setDeclaringWinnersId(null);
  };

  const handleClearContestWinners = async (c) => {
    if (
      !window.confirm(
        `Clear winners for “${c.title}”? This removes the published winner list and removes this challenge’s leaderboard points from every user who submitted picks (responses are unchanged — run “Score all” again if you need to refresh points).`
      )
    )
      return;
    setSaving(true);
    try {
      const respSnap = await getDocs(collection(db, 'prediction_contexts', c.id, 'responses'));
      const uids = respSnap.docs.map((d) => d.id);
      const userSnaps = await Promise.all(uids.map((uid) => getDoc(doc(db, 'users', uid))));
      let ub = writeBatch(db);
      let un = 0;
      let usersUpdated = 0;
      for (let i = 0; i < uids.length; i++) {
        if (!userSnaps[i].exists()) continue;
        ub.update(doc(db, 'users', uids[i]), { [`seasonContestLeaderboard.${c.id}`]: deleteField() });
        un += 1;
        usersUpdated += 1;
        if (un >= 400) {
          await ub.commit();
          ub = writeBatch(db);
          un = 0;
        }
      }
      if (un > 0) await ub.commit();

      await updateDoc(doc(db, 'prediction_contexts', c.id), {
        contestWinnerUserIds: deleteField(),
        contestWinnerDisplayNames: deleteField(),
        contestWinningPoints: deleteField(),
        winnersDeclaredAt: deleteField(),
        leaderboardBonusPerWinner: deleteField(),
        updatedAt: new Date().toISOString(),
      });
      const skipped = uids.length - usersUpdated;
      setMessage(
        `Winner list cleared. Removed this challenge’s leaderboard points for ${usersUpdated} user profile(s).` +
          (skipped ? ` ${skipped} response(s) had no user document.` : '')
      );
      await loadContexts();
    } catch (err) {
      setMessage('Error: ' + (err.message || ''));
    }
    setSaving(false);
  };

  if (loading) return <p className="muted">Loading season prediction challenges…</p>;

  return (
    <section id="section-prediction-contexts" className="admin-section">
      <h2>Season prediction challenges</h2>
      <div className="prediction-context-intro">
        <p>
          Build qualifier-style contests (for example, which teams reach the quarter-finals). Players pick teams from your
          pool; you set the real result, run scoring, and optionally declare contest winners.
        </p>
        <ol className="prediction-context-steps-intro">
          <li>
            <strong>Edit setup</strong> — title, description, deadline (date &amp; time), team pool, points table, and optional correct answer.
          </li>
          <li>
            <strong>Scoring &amp; winners</strong> — save the official qualifying teams, score everyone, then declare winners if you want.
          </li>
        </ol>
      </div>

      <div className="prediction-context-toolbar">
        <button type="button" className="btn btn-primary" onClick={openCreate}>
          + New challenge
        </button>
      </div>

      {formOpen && (
        <div ref={formAnchorRef} id="prediction-context-form" className="config-card" style={{ marginBottom: '1.5rem', padding: '1rem' }}>
          <h3>{editingId ? 'Edit challenge' : 'New challenge'}</h3>
          <p className="muted" style={{ fontSize: '0.9rem', marginTop: '-0.25rem' }}>
            Users see this under Season predictions on the dashboard when the challenge is visible.
          </p>
          <form onSubmit={handleSaveContext} className="account-form">
            <div className="prediction-context-form-block">
              <h4>Basics</h4>
              <div className="form-group">
                <label>Title</label>
                <input value={formTitle} onChange={(e) => setFormTitle(e.target.value)} placeholder="e.g. IPL 2026 Quarter-finalists" required />
              </div>
              <div className="form-group">
                <label>Description (optional)</label>
                <textarea value={formDescription} onChange={(e) => setFormDescription(e.target.value)} rows={2} placeholder="Short text shown under the title" />
              </div>
              <div className="form-group">
                <label>Picks per player</label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={formMaxSelections}
                  onChange={(e) => setFormMaxSelections(parseInt(e.target.value, 10) || 4)}
                />
                <p className="muted" style={{ fontSize: '0.8rem', margin: '0.35rem 0 0 0' }}>
                  Each user must select exactly this many teams from your pool.
                </p>
              </div>
              <div className="form-group">
                <label>Deadline (optional, date &amp; time)</label>
                <input
                  type="datetime-local"
                  step={60}
                  value={formDeadline}
                  onChange={(e) => setFormDeadline(e.target.value)}
                />
                <p className="muted" style={{ fontSize: '0.8rem', margin: '0.35rem 0 0 0' }}>
                  Uses your device local time. Leave empty for no deadline message on the player card.
                </p>
              </div>
            </div>
            <div className="prediction-context-form-block">
              <h4>Team pool</h4>
              <div className="form-group">
                <label>Teams players can choose from</label>
              <div className="filter-tags" style={{ marginTop: '0.35rem' }}>
                {teams.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`filter-tag ${formEligibleIds.includes(t.id) ? 'active' : ''}`}
                    onClick={() => toggleEligibleTeam(t.id)}
                  >
                    {getTeamLabel(t)}
                  </button>
                ))}
              </div>
              {teams.length === 0 && <p className="muted">Add teams under Admin → Teams first.</p>}
            </div>
            {formEligibleIds.length > 0 && (
              <div className="form-group">
                <label>Official result (optional)</label>
                <p className="muted" style={{ fontSize: '0.85rem', margin: '0 0 0.5rem 0' }}>
                  When you know the real qualifiers, choose exactly{' '}
                  <strong>{Math.max(1, Math.min(20, parseInt(formMaxSelections, 10) || 4))}</strong> team(s) here, or leave
                  this empty until later (you can also set this under Scoring &amp; winners).
                </p>
                <div className="filter-tags" style={{ marginTop: '0.35rem' }}>
                  {teams
                    .filter((t) => formEligibleIds.includes(t.id))
                    .map((t) => {
                      const maxSel = Math.max(1, Math.min(20, parseInt(formMaxSelections, 10) || 4));
                      const on = formOfficialIds.includes(t.id);
                      const atCap = !on && formOfficialIds.length >= maxSel;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          className={`filter-tag ${on ? 'active' : ''}`}
                          disabled={atCap}
                          onClick={() => toggleFormOfficialTeam(t.id)}
                          title={atCap ? `At most ${maxSel} teams` : undefined}
                        >
                          {getTeamLabel(t)}
                        </button>
                      );
                    })}
                </div>
                <p className="muted" style={{ fontSize: '0.85rem', margin: '0.35rem 0 0 0' }}>
                  Selected: {formOfficialIds.length} / {Math.max(1, Math.min(20, parseInt(formMaxSelections, 10) || 4))}
                </p>
              </div>
            )}
            </div>
            <div className="prediction-context-form-block">
              <h4>Points table</h4>
              <div className="form-group">
              <label>Points by how many picks were correct</label>
              <p className="muted" style={{ fontSize: '0.85rem', margin: '0 0 0.5rem 0' }}>
                For each player we count how many of their picks match the official result. The row for that count decides
                their points. Add a row for 0 correct if you want to award points when none match.
              </p>
              <table className="admin-table" style={{ width: '100%', maxWidth: '400px' }}>
                <thead>
                  <tr>
                    <th>Correct picks (N)</th>
                    <th>Points</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {formTiers.map((row, idx) => (
                    <tr key={idx}>
                      <td>
                        <input
                          type="number"
                          min={0}
                          max={20}
                          value={row.correctCount}
                          onChange={(e) => updateTierRow(idx, 'correctCount', parseInt(e.target.value, 10) || 0)}
                          style={{ width: '4rem' }}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          step="0.01"
                          value={row.points}
                          onChange={(e) => updateTierRow(idx, 'points', parseFloat(e.target.value) || 0)}
                          style={{ width: '5rem' }}
                        />
                      </td>
                      <td>
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => removeTierRow(idx)}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button type="button" className="btn btn-sm btn-secondary" style={{ marginTop: '0.5rem' }} onClick={addTierRow}>
                Add tier
              </button>
            </div>
            </div>
            <div className="modal-actions">
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Saving…' : editingId ? 'Save challenge' : 'Create challenge'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setFormOpen(false);
                  resetForm();
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {contexts.length === 0 ? (
        <div className="prediction-context-empty">
          <p>No challenges yet. Create one so players can submit picks on the Season predictions page.</p>
          <button type="button" className="btn btn-primary" onClick={openCreate}>
            + New challenge
          </button>
        </div>
      ) : (
        <ul className="prediction-contexts-admin-list">
          {contexts.map((c) => {
            const expanded = expandedId === c.id;
            const eligible = teams.filter((t) => (c.eligibleTeamIds || []).includes(t.id));
            const official = officialSelections[c.id] || [];
            const maxSel = Math.max(1, parseInt(c.maxSelections, 10) || 4);
            const officialSaved =
              Array.isArray(c.officialEligibleTeamIds) && c.officialEligibleTeamIds.length === maxSel;
            return (
              <li key={c.id} className="prediction-context-admin-row">
                <article className="prediction-context-admin-card">
                  <div className="prediction-context-admin-header">
                    <div className="insight-pending-content">
                      <h3 className="prediction-context-card-title">{c.title}</h3>
                      <p className="prediction-context-card-meta" style={{ fontSize: '0.82rem', marginTop: '0.15rem' }}>
                        Challenge code: <code style={{ fontSize: '0.85em' }}>{c.contextCode || c.id}</code>
                      </p>
                      <div className="prediction-context-status-row" aria-label="Challenge status">
                        <span
                          className={`prediction-context-badge ${c.acceptingPredictions ? 'prediction-context-badge-picks-open' : 'prediction-context-badge-picks-closed'}`}
                        >
                          {c.acceptingPredictions ? 'Picks open' : 'Picks closed'}
                        </span>
                        <span
                          className={`prediction-context-badge ${c.active ? 'prediction-context-badge-live' : 'prediction-context-badge-hidden'}`}
                        >
                          {c.active ? 'Shown on dashboard' : 'Hidden from dashboard'}
                        </span>
                        {officialSaved && (
                          <span className="prediction-context-badge prediction-context-badge-done">Official result saved</span>
                        )}
                      </div>
                      {c.description && <p className="prediction-context-card-meta">{c.description}</p>}
                      <p className="prediction-context-card-meta">
                        <strong>{maxSel}</strong> picks per player
                        {c.deadline && (
                          <>
                            {' '}
                            · Deadline <strong>{formatContextDeadlineDisplay(c.deadline)}</strong>
                          </>
                        )}
                      </p>
                      <p className="prediction-context-card-meta">
                        Points:{' '}
                        {(normalizeContextTiers(c.tiers) || [])
                          .map((t) => `${t.correctCount} right → ${t.points} pts`)
                          .join(' · ') || '—'}
                      </p>
                      {Array.isArray(c.contestWinnerUserIds) && c.contestWinnerUserIds.length > 0 && (
                        <p className="prediction-context-card-meta" style={{ marginTop: '0.5rem' }}>
                          <span className="points-positive" style={{ fontWeight: 600 }}>
                            Winners:
                          </span>{' '}
                          {(c.contestWinnerDisplayNames || c.contestWinnerUserIds).join(', ')}
                          {c.contestWinningPoints != null && (
                            <span className="muted">
                              {' '}
                              ({c.contestWinningPoints} pts{c.contestWinnerUserIds.length > 1 ? ' each' : ''})
                            </span>
                          )}
                          {c.winnersDeclaredAt && (
                            <span className="muted">
                              {' '}
                              · Declared {formatDdMmYyyy(c.winnersDeclaredAt)}
                            </span>
                          )}
                        </p>
                      )}
                    </div>
                    <div className="insight-pending-actions prediction-context-admin-actions">
                      <div className="prediction-context-actions-main">
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={() => setExpandedId(expanded ? null : c.id)}
                        >
                          {expanded ? 'Close scoring tools' : 'Scoring & winners'}
                        </button>
                        <button type="button" className="btn btn-sm btn-outline" onClick={() => openEdit(c)}>
                          Edit setup
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-secondary"
                          onClick={() => handleToggleActive(c, !c.active)}
                          disabled={saving}
                        >
                          {c.active ? 'Hide from dashboard' : 'Show on dashboard'}
                        </button>
                      </div>
                      <div className="prediction-context-actions-danger">
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => handleDeleteContext(c)} disabled={saving}>
                          Delete challenge
                        </button>
                      </div>
                    </div>
                  </div>
                  {expanded && (
                  <div className="prediction-context-manage-panel">
                    <div className="prediction-context-manage-step">
                      <span className="step-label">Step 1 of 3</span>
                      <h4>Save the official result</h4>
                      <p className="muted" style={{ fontSize: '0.9rem', marginTop: 0 }}>
                        Choose the <strong>{maxSel}</strong> team(s) that actually qualified, then save. Same as under Edit
                        setup if you prefer to work there.
                      </p>
                    <div className="filter-tags" style={{ marginBottom: '0.75rem' }}>
                      {eligible.map((t) => {
                        const maxSel = Math.max(1, parseInt(c.maxSelections, 10) || 4);
                        const on = official.includes(t.id);
                        const atCap = !on && official.length >= maxSel;
                        return (
                          <button
                            key={t.id}
                            type="button"
                            className={`filter-tag ${on ? 'active' : ''}`}
                            disabled={atCap}
                            onClick={() => toggleOfficialTeam(c.id, t.id, c.maxSelections)}
                            title={atCap ? `At most ${maxSel} teams` : undefined}
                          >
                            {getTeamLabel(t)}
                          </button>
                        );
                      })}
                    </div>
                    <p className="muted" style={{ fontSize: '0.85rem', margin: '0 0 0.75rem 0' }}>
                      Selected: {official.length} / {c.maxSelections || 4}
                      {official.length > 0 && official.length !== (c.maxSelections || 4) && (
                        <span> — submit is disabled until the count matches.</span>
                      )}
                    </p>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={() => setOfficialForContext(c.id, c)}
                      disabled={
                        saving ||
                        (official.length > 0 && official.length !== Math.max(1, parseInt(c.maxSelections, 10) || 4))
                      }
                    >
                      Save official result
                    </button>
                    </div>
                    <div className="prediction-context-manage-step">
                      <span className="step-label">Step 2 of 3</span>
                      <h4>Score all players</h4>
                      <p className="muted" style={{ fontSize: '0.9rem', marginTop: 0 }}>
                        Writes each player’s points (from how many picks were correct and your points table) on their
                        submission and on the main leaderboard. Closes picks. Re-open only if people need to change picks
                        again before you re-score.
                      </p>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={() => handleScoreContext(c)}
                          disabled={scoringId === c.id || saving}
                        >
                          {scoringId === c.id ? 'Scoring…' : 'Score all & close picks'}
                        </button>
                        {!c.acceptingPredictions && (
                          <button
                            type="button"
                            className="btn btn-sm btn-secondary"
                            onClick={() => handleReopenPredictions(c)}
                            disabled={saving}
                          >
                            Re-open picks
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="prediction-context-manage-step">
                      <span className="step-label">Step 3 of 3 · optional</span>
                      <h4>Declare contest winners</h4>
                      <p className="muted" style={{ fontSize: '0.9rem', marginTop: 0, marginBottom: '0.75rem' }}>
                        Optional: publish who tied for the top score on the Season predictions page. Leaderboard points for
                        every player already came from Step 2 (correct picks); this step does not change totals.
                      </p>
                      <p className="muted" style={{ fontSize: '0.82rem', margin: '0 0 0.75rem 0' }}>
                        <strong>Clear winners</strong> removes that list and strips this challenge from the main leaderboard for{' '}
                        <em>all</em> participants who saved picks (response docs are unchanged; use <strong>Score all</strong>{' '}
                        again to re-apply points).
                      </p>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={() => handleDeclareContestWinners(c)}
                          disabled={declaringWinnersId === c.id || saving}
                        >
                          {declaringWinnersId === c.id ? 'Declaring…' : 'Declare winners'}
                        </button>
                        {Array.isArray(c.contestWinnerUserIds) && c.contestWinnerUserIds.length > 0 && (
                          <button
                            type="button"
                            className="btn btn-sm btn-secondary"
                            onClick={() => handleClearContestWinners(c)}
                            disabled={saving || declaringWinnersId === c.id}
                            title="Clears the winner list and removes this challenge’s leaderboard points for every user who submitted picks"
                          >
                            Clear winners
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                  )}
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
