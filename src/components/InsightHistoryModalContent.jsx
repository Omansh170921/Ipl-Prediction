import { useState, useEffect } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../firebase/config';
import { to2Decimals } from '../utils/points';

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

  if (!completedMatches?.length) {
    return <p className="muted">No completed matches for the selected date range.</p>;
  }

  if (loading) {
    return <p className="muted">Loading insight history…</p>;
  }

  if (error) {
    return <p className="alert alert-error">{error}</p>;
  }

  if (!rows?.length) {
    return <p className="muted">No data.</p>;
  }

  return (
    <>
      <p className="muted" style={{ marginBottom: '0.75rem', fontSize: '0.9rem' }}>
        Latest matches first. Per match: approved questions, your attempts, correct / wrong (when an official answer exists), points
        earned for that match, then <strong>→ Cumulative</strong> insight total (chronological).
      </p>
      <div className="points-history-scroll">
        <ul className="points-history-list insight-history-list">
          {rows.map(
            ({ m, totalQ, attempted, correct, wrong, pointsEarned, runningInsight: ri }) => (
              <li key={m.id} className="points-history-item insight-history-item">
                <span className="points-history-match">
                  #{m.matchNumber || m.id} {getTeamCode(m.team1, teams)} vs {getTeamCode(m.team2, teams)} ({m.date})
                </span>
                <div className="insight-history-stats">
                  <span>
                    Total Q: <strong>{totalQ}</strong>
                  </span>
                  <span>
                    · Attempted: <strong>{attempted}</strong>
                  </span>
                  <span>
                    · Correct: <strong className="points-positive">{correct}</strong>
                  </span>
                  <span>
                    · Wrong: <strong className="points-negative">{wrong}</strong>
                  </span>
                  <span>
                    · Points earned: <strong className="points-positive">{pointsEarned}</strong>
                  </span>
                  <span className="points-history-total">
                    → Cumulative: <strong>{ri}</strong>
                  </span>
                </div>
              </li>
            )
          )}
        </ul>
      </div>
    </>
  );
}
