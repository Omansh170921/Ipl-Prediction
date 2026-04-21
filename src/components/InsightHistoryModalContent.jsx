import { useState, useEffect, useMemo } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../firebase/config';
import { to2Decimals } from '../utils/points';
import CumulativePointsLineChart from './CumulativePointsLineChart';

function normAns(s) {
  return String(s ?? '').trim().toLowerCase();
}

/**
 * Per-match insight stats for one user: approved questions, attempts, correct/wrong (when correctAnswer is set),
 * points from match.insightPointResults[uid], cumulative insight.
 */
export default function InsightHistoryModalContent({
  userId,
  completedMatches,
  teams,
  getTeamCode,
  /** Increment when leaderboard data is refreshed so insight stats reload. */
  leaderboardRefresh = 0,
}) {
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refreshKey = (completedMatches || [])
    .map((m) => `${String(m.id)}:${Number(m.insightPointResults?.[userId] ?? 0)}`)
    .join('|');

  useEffect(() => {
    const matches = completedMatches;
    if (!userId || !matches?.length) {
      setRows([]);
      setLoading(false);
      return;
    }

    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [qSnap, aSnap] = await Promise.all([
          getDocs(query(collection(db, 'cricket_questions'), where('approved', '==', true))),
          getDocs(query(collection(db, 'cricket_answers'), where('userId', '==', userId))),
        ]);
        if (cancelled) return;

        const answersByQuestionId = {};
        aSnap.docs.forEach((d) => {
          const x = d.data();
          const qid = x.questionId != null ? String(x.questionId) : '';
          if (qid) answersByQuestionId[qid] = x.answer;
        });

        const questionsByMatchId = {};
        qSnap.docs.forEach((d) => {
          const data = d.data();
          const mid = data.matchId;
          if (!mid) return;
          const key = String(mid);
          if (!questionsByMatchId[key]) questionsByMatchId[key] = [];
          questionsByMatchId[key].push({ id: d.id, ...data });
        });

        const rowsChrono = [];
        let runningInsight = 0;

        for (const m of matches) {
          const mid = String(m.id);
          const qs = questionsByMatchId[mid] || [];
          const totalQ = qs.length;
          let attempted = 0;
          let correct = 0;
          let wrong = 0;

          for (const q of qs) {
            const rawAns = answersByQuestionId[String(q.id)];
            if (rawAns == null || String(rawAns).trim() === '') continue;
            attempted++;
            const ca = q.correctAnswer;
            if (ca == null || String(ca).trim() === '') continue;
            if (normAns(rawAns) === normAns(ca)) correct++;
            else wrong++;
          }

          const pointsEarned = to2Decimals(Number(m.insightPointResults?.[userId] ?? 0));
          runningInsight = to2Decimals(runningInsight + pointsEarned);
          rowsChrono.push({
            m,
            totalQ,
            attempted,
            correct,
            wrong,
            pointsEarned,
            runningInsight,
          });
        }

        if (!cancelled) setRows([...rowsChrono].reverse());
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Failed to load insight history');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, refreshKey, leaderboardRefresh]);

  const summary = useMemo(() => {
    if (!rows?.length) return null;
    const latest = rows[0];
    const totalMatches = rows.length;
    const totalInsight = latest.runningInsight;
    let totalAttempted = 0;
    let totalCorrect = 0;
    rows.forEach((r) => {
      totalAttempted += r.attempted;
      totalCorrect += r.correct;
    });
    return { totalMatches, totalInsight, totalAttempted, totalCorrect };
  }, [rows]);

  const insightChartValues = useMemo(() => {
    if (!rows?.length) return [];
    return [...rows].reverse().map((r) => r.runningInsight);
  }, [rows]);

  if (!completedMatches?.length) {
    return (
      <div className="insight-history-empty">
        <p className="insight-history-empty-title">No insight history yet</p>
        <p className="muted">Completed matches with approved insight questions will appear here.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="insight-history-loading" aria-busy="true">
        <span className="insight-history-loading-dot" aria-hidden />
        <p>Loading your insight history…</p>
      </div>
    );
  }

  if (error) {
    return <p className="alert alert-error">{error}</p>;
  }

  if (!rows?.length) {
    return (
      <div className="insight-history-empty">
        <p className="insight-history-empty-title">Nothing to show</p>
        <p className="muted">We couldn&apos;t build a history for this range. Try again.</p>
      </div>
    );
  }

  return (
    <div className="insight-history-root">
      {summary && (
        <div className="insight-history-summary" role="region" aria-label="Insight summary">
          <div className="insight-history-summary-main">
            <span className="insight-history-summary-label">Total insight points</span>
            <span className="insight-history-summary-value">{summary.totalInsight}</span>
          </div>
          <ul className="insight-history-summary-grid">
            <li>
              <span className="muted">Matches</span>
              <strong>{summary.totalMatches}</strong>
            </li>
            <li>
              <span className="muted">Answers given</span>
              <strong>{summary.totalAttempted}</strong>
            </li>
            <li>
              <span className="muted">Correct (official)</span>
              <strong className="points-positive">{summary.totalCorrect}</strong>
            </li>
          </ul>
        </div>
      )}

      {insightChartValues.length > 0 ? (
        <CumulativePointsLineChart
          caption="Cumulative insight points (chronological)"
          values={insightChartValues}
          variant="insight"
        />
      ) : null}

      <p className="insight-history-intro">
        Newest matches first. Each row shows how you did on that match&apos;s insight questions and your running insight total after it.
      </p>

      <div className="points-history-scroll insight-history-scroll">
        <ul className="insight-history-cards">
          {rows.map(({ m, totalQ, attempted, correct, wrong, pointsEarned, runningInsight: ri }) => (
            <li key={m.id} className="insight-history-card">
              <div className="insight-history-card-head">
                <span className="insight-history-card-badge">Match #{m.matchNumber || m.id}</span>
                <span className="insight-history-card-date">{m.date}</span>
              </div>
              <p className="insight-history-card-teams">
                {getTeamCode(m.team1, teams)} <span className="insight-history-vs">vs</span> {getTeamCode(m.team2, teams)}
              </p>
              <dl className="insight-history-dl">
                <div>
                  <dt>Questions</dt>
                  <dd>{totalQ}</dd>
                </div>
                <div>
                  <dt>You answered</dt>
                  <dd>{attempted}</dd>
                </div>
                <div>
                  <dt>Correct</dt>
                  <dd className="points-positive">{correct}</dd>
                </div>
                <div>
                  <dt>Wrong</dt>
                  <dd className="points-negative">{wrong}</dd>
                </div>
                <div>
                  <dt>Points this match</dt>
                  <dd className="points-positive">{pointsEarned}</dd>
                </div>
                <div className="insight-history-dl-cumulative">
                  <dt>Running total</dt>
                  <dd>{ri}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
