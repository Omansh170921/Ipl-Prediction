import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import {
  collection,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  deleteDoc,
  query,
  where,
  increment,
  runTransaction,
} from 'firebase/firestore';
import { db } from '../firebase/config';
import Sidebar from '../components/Sidebar';
import { toInitCap } from '../utils/format';

function formatMatchTime(time) {
  if (!time) return 'TBD';
  if (time.includes(':') && /^\d{1,2}:\d{2}$/.test(time)) {
    const [h, m] = time.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${m.toString().padStart(2, '0')} ${period}`;
  }
  return time;
}

function getTeamCode(teamName, teams) {
  const t = teams.find(x => (x.name || '').toLowerCase() === (teamName || '').toLowerCase());
  return (t?.code || '').trim() || teamName || '';
}

export default function InsightApproval() {
  const navigate = useNavigate();
  const { user, userProfile, logout } = useAuth();
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [teams, setTeams] = useState([]);
  const [matches, setMatches] = useState([]);
  const [pendingQuestions, setPendingQuestions] = useState([]);
  const [questionsAwaitingAnswer, setQuestionsAwaitingAnswer] = useState([]);
  const [insightApprovalLoading, setInsightApprovalLoading] = useState(false);
  const [approvingQid, setApprovingQid] = useState(null);
  const [rejectingQid, setRejectingQid] = useState(null);
  const [removingQid, setRemovingQid] = useState(null);
  const [answerModalQuestion, setAnswerModalQuestion] = useState(null);
  const [correctAnswerInput, setCorrectAnswerInput] = useState('');
  const [submittingAnswer, setSubmittingAnswer] = useState(false);
  const [expandedInsightMatchId, setExpandedInsightMatchId] = useState(null);
  const [requiredApprovals, setRequiredApprovals] = useState(1);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useAutoDismiss(message, setMessage);

  /** When requiredApprovals=2, need 1 (50%). When 4, need 2. Formula: ceil(required * 0.5), min 1. */
  function getMinApprovalsToShow(req) {
    const r = Math.max(1, parseInt(req, 10) || 1);
    return Math.max(1, Math.ceil(r * 0.5));
  }

  useEffect(() => {
    const init = async () => {
      if (!user) return;
      setLoading(true);
      try {
        const [ciSnap, approverSnap] = await Promise.all([
          getDoc(doc(db, 'settings', 'cricketInsights')),
          getDoc(doc(db, 'insight_approvers', user.uid)),
        ]);
        const isAdmin = userProfile?.isAdmin === true || userProfile?.isAdmin === 'true';
        const isApprover = approverSnap?.exists?.();
        const approverIds = ciSnap.exists?.() ? (ciSnap.data().insightApproverIds || []) : [];
        const inApproverList = approverIds.includes(user.uid);
        const req = ciSnap.exists?.() ? (ciSnap.data().requiredApprovals ?? 1) : 1;
        setRequiredApprovals(Math.max(1, Math.min(10, parseInt(req, 10) || 1)));
        if (!isAdmin && !isApprover && !inApproverList) {
          setAuthorized(false);
          setLoading(false);
          return;
        }
        setAuthorized(true);

        const [teamsSnap, matchesSnap, pendingSnap, awaitingSnap] = await Promise.all([
          getDocs(collection(db, 'teams')),
          getDocs(collection(db, 'matches')),
          getDocs(query(
            collection(db, 'cricket_questions'),
            where('approved', '==', false),
            where('status', '==', 'pending')
          )),
          getDocs(query(
            collection(db, 'cricket_questions'),
            where('approved', '==', true),
            where('correctAnswer', '==', null)
          )),
        ]);
        const today = new Date().toISOString().split('T')[0];
        setTeams(teamsSnap.docs.map(d => ({ id: d.id, ...d.data() })));
        const allMatches = matchesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const todayMatchesList = allMatches.filter(m => (m.date || '') === today).sort((a, b) => {
          const cmpDate = (a.date || '').localeCompare(b.date || '');
          if (cmpDate !== 0) return cmpDate;
          return (a.time || '').localeCompare(b.time || '');
        });
        setMatches(todayMatchesList);
        setPendingQuestions(pendingSnap.docs.map(d => ({ id: d.id, ...d.data() })));
        setQuestionsAwaitingAnswer(awaitingSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      } catch (err) {
        console.error('InsightApproval init error:', err);
        setMessage('Error loading: ' + (err.message || ''));
      }
      setLoading(false);
    };
    init();
  }, [user, userProfile]);

  const refreshQuestions = async () => {
    if (!authorized) return;
    setInsightApprovalLoading(true);
    try {
      const [pendingSnap, awaitingSnap] = await Promise.all([
        getDocs(query(
          collection(db, 'cricket_questions'),
          where('approved', '==', false),
          where('status', '==', 'pending')
        )),
        getDocs(query(
          collection(db, 'cricket_questions'),
          where('approved', '==', true),
          where('correctAnswer', '==', null)
        )),
      ]);
      setPendingQuestions(pendingSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      setQuestionsAwaitingAnswer(awaitingSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
      console.error('Refresh error:', err);
    }
    setInsightApprovalLoading(false);
  };

  const handleApproveQuestion = async (q) => {
    if (!q) return;
    setApprovingQid(q.id);
    try {
      const minRequired = getMinApprovalsToShow(requiredApprovals);
      await runTransaction(db, async (transaction) => {
        const ref = doc(db, 'cricket_questions', q.id);
        const snap = await transaction.get(ref);
        if (!snap.exists()) throw new Error('Question not found');
        const data = snap.data();
        const approvedBy = Array.isArray(data.approvedBy) ? data.approvedBy : [];
        if (approvedBy.includes(user.uid)) {
          throw new Error('You have already approved this question.');
        }
        const newApprovedBy = [...approvedBy, user.uid];
        const isFullyApproved = newApprovedBy.length >= minRequired;
        transaction.update(ref, {
          approvedBy: newApprovedBy,
          ...(isFullyApproved
            ? { approved: true, status: 'approved', approvedAt: new Date().toISOString() }
            : {}),
        });
      });
      const approvedBy = Array.isArray(q.approvedBy) ? q.approvedBy : [];
      const newCount = approvedBy.length + 1;
      const isFullyApproved = newCount >= minRequired;
      setMessage(
        isFullyApproved
          ? 'Question approved. It is now visible to users.'
          : `Approved (${newCount}/${minRequired}). Need ${minRequired - newCount} more to show to users.`
      );
      await refreshQuestions();
    } catch (err) {
      setMessage(err?.message === 'You have already approved this question.'
        ? err.message
        : 'Error approving: ' + (err.message || ''));
    }
    setApprovingQid(null);
  };

  const openAnswerModal = (q) => {
    setAnswerModalQuestion(q);
    if (q.type === 'yesno') setCorrectAnswerInput('Yes');
    else if (q.type === 'multiple' && (q.options || []).length > 0) setCorrectAnswerInput((q.options || [])[0] || '');
    else setCorrectAnswerInput('');
  };

  const handleSetCorrectAnswer = async (e) => {
    e.preventDefault();
    const q = answerModalQuestion;
    if (!q || !correctAnswerInput.trim()) return;
    setSubmittingAnswer(true);
    try {
      await updateDoc(doc(db, 'cricket_questions', q.id), {
        correctAnswer: correctAnswerInput.trim(),
        status: 'answered',
        answeredAt: new Date().toISOString(),
      });
      const answersSnap = await getDocs(query(collection(db, 'cricket_answers'), where('questionId', '==', q.id)));
      const correctAnswerNorm = String(correctAnswerInput).trim().toLowerCase();
      const winners = answersSnap.docs
        .map(d => ({ ...d.data(), id: d.id }))
        .filter(a => String(a.answer || '').trim().toLowerCase() === correctAnswerNorm);
      const matchId = q.matchId;
      if (matchId) {
        const updates = {};
        winners.forEach(w => {
          if (w.userId) updates[`insightPointResults.${w.userId}`] = increment(1);
        });
        if (Object.keys(updates).length > 0) {
          await updateDoc(doc(db, 'matches', matchId), updates);
        }
      }
      setAnswerModalQuestion(null);
      setCorrectAnswerInput('');
      setMessage(`Correct answer set. ${winners.length} user(s) awarded +1 point.`);
      await refreshQuestions();
    } catch (err) {
      setMessage('Error: ' + (err.message || ''));
    }
    setSubmittingAnswer(false);
  };

  const handleRejectQuestion = async (q) => {
    if (!confirm(`Reject question: "${(q.question || '').slice(0, 50)}..."?`)) return;
    setRejectingQid(q.id);
    try {
      await updateDoc(doc(db, 'cricket_questions', q.id), {
        status: 'rejected',
        rejectedAt: new Date().toISOString(),
      });
      setMessage('Question rejected');
      await refreshQuestions();
    } catch (err) {
      setMessage('Error rejecting: ' + (err.message || ''));
    }
    setRejectingQid(null);
  };

  const handleRemoveQuestion = async (q) => {
    if (!confirm(`Permanently remove question: "${(q.question || '').slice(0, 50)}..."? This cannot be undone.`)) return;
    setRemovingQid(q.id);
    try {
      await deleteDoc(doc(db, 'cricket_questions', q.id));
      setMessage('Question removed.');
      await refreshQuestions();
    } catch (err) {
      setMessage('Error removing: ' + (err.message || ''));
    }
    setRemovingQid(null);
  };

  if (!user) {
    navigate('/login');
    return null;
  }

  if (loading) {
    return (
      <div className="app-layout">
        <Sidebar admin={false} userProfile={userProfile} user={user} onLogout={logout} isMobileOpen={mobileMenuOpen} onMobileClose={() => setMobileMenuOpen(false)} />
        <main className="app-main">
          <header className="dashboard-header">
            <button type="button" className="hamburger-btn" onClick={() => setMobileMenuOpen(true)} aria-label="Open menu">☰</button>
            <h1>Cricket Insights Approval</h1>
          </header>
          <p>Loading...</p>
        </main>
      </div>
    );
  }

  if (!authorized) {
    return (
      <div className="app-layout">
        <Sidebar admin={false} userProfile={userProfile} user={user} onLogout={logout} isMobileOpen={mobileMenuOpen} onMobileClose={() => setMobileMenuOpen(false)} />
        <main className="app-main">
          <header className="dashboard-header">
            <button type="button" className="hamburger-btn" onClick={() => setMobileMenuOpen(true)} aria-label="Open menu">☰</button>
            <h1>Cricket Insights Approval</h1>
          </header>
          <h2>Cricket Insights Approval</h2>
          <p className="alert alert-error">Access denied. You are not configured as an approver.</p>
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/dashboard')}>
            Back to Dashboard
          </button>
        </main>
      </div>
    );
  }

  return (
    <div className="app-layout">
      <Sidebar
        admin={false}
        userProfile={userProfile}
        user={user}
        onLogout={logout}
        activeSection="insightApproval"
        isMobileOpen={mobileMenuOpen}
        onMobileClose={() => setMobileMenuOpen(false)}
        onSectionChange={(s) => {
          if (['dashboard', 'teams', 'rules', 'matches', 'leaderboard', 'account'].includes(s)) {
            navigate('/dashboard', { state: { section: s } });
          }
        }}
        isInsightApprover={true}
      />
      <main className="app-main">
        <header className="dashboard-header">
          <button type="button" className="hamburger-btn" onClick={() => setMobileMenuOpen(true)} aria-label="Open menu">☰</button>
          <h1>Cricket Insights Approval</h1>
        </header>
        {message && <div className="alert alert-success">{message}</div>}
        <section className="admin-section">
          <p className="muted">Approve questions or set correct answer after match completes.</p>
          {insightApprovalLoading ? (
            <p>Loading...</p>
          ) : (() => {
            const matchesWithInsights = matches.filter((m) => {
              const matchPending = pendingQuestions.filter(q => q.matchId === m.id);
              const matchAwaiting = questionsAwaitingAnswer.filter(q => q.matchId === m.id);
              return matchPending.length > 0 || matchAwaiting.length > 0;
            });
            return matchesWithInsights.length === 0 ? (
              <p className="no-matches">No insight questions pending approval for today&apos;s matches.</p>
            ) : (
            <div className="matches-table">
              {matchesWithInsights.map((m) => {
                const matchPending = pendingQuestions.filter(q => q.matchId === m.id);
                const matchAwaiting = questionsAwaitingAnswer.filter(q => q.matchId === m.id);
                const hasInsights = matchPending.length > 0 || matchAwaiting.length > 0;
                const isInsightExpanded = expandedInsightMatchId === m.id;
                const matchCompleted = (m.status || '').toLowerCase() === 'completed';
                return (
                  <div key={m.id} className="match-row">
                    <div className="match-info">
                      <span className="match-teams">{getTeamCode(m.team1, teams)} vs {getTeamCode(m.team2, teams)}</span>
                      <span className="match-meta">{m.date} · {formatMatchTime(m.time || m.slot)}</span>
                      {m.winner && <span className="match-winner">Winner: {getTeamCode(m.winner, teams)}</span>}
                      <span className={`match-status ${(m.status || 'open').toLowerCase() === 'completed' ? 'completed' : m.date === new Date().toISOString().split('T')[0] ? 'today' : 'open'}`}>
                      {(m.status || 'open').toLowerCase() === 'completed'
                        ? 'completed'
                        : m.date === new Date().toISOString().split('T')[0]
                          ? 'today'
                          : 'upcoming'}
                    </span>
                    </div>
                    <div className="match-actions">
                      <button
                        type="button"
                        className={`btn btn-sm ${hasInsights ? 'btn-secondary' : ''}`}
                        onClick={() => setExpandedInsightMatchId(isInsightExpanded ? null : m.id)}
                      >
                        💡 Insights {hasInsights ? `(${matchPending.length + matchAwaiting.length})` : ''}
                      </button>
                    </div>
                    {isInsightExpanded && (
                      <div className="match-insight-approval">
                        {matchPending.length > 0 && (
                          <div className="insight-subsection">
                            <h4>Pending approval</h4>
                            <ul className="rules-list">
                              {matchPending.map(q => {
                                const approvedBy = Array.isArray(q.approvedBy) ? q.approvedBy : [];
                                const minRequired = getMinApprovalsToShow(requiredApprovals);
                                const alreadyApproved = approvedBy.includes(user.uid);
                                return (
                                <li key={q.id} className="insight-pending-item">
                                  <div className="insight-pending-content">
                                    <strong>{q.question}</strong>
                                    <span className="muted"> · {q.type === 'yesno' ? 'Yes/No' : q.type === 'multiple' ? 'Multiple Choice' : 'Text'}</span>
                                    {requiredApprovals > 1 && (
                                      <span className="muted" style={{ marginLeft: '0.25rem' }}>
                                        ({approvedBy.length}/{minRequired} approvals)
                                      </span>
                                    )}
                                    {(q.options || []).length > 0 && (
                                      <p className="muted" style={{ margin: '0.25rem 0 0 0' }}>Options: {q.options.join(', ')}</p>
                                    )}
                                  </div>
                                  <div className="insight-pending-actions">
                                    <button type="button" className="btn btn-sm btn-primary btn-icon-only" onClick={() => handleApproveQuestion(q)} disabled={approvingQid === q.id || alreadyApproved} title={alreadyApproved ? 'You already approved' : approvingQid === q.id ? 'Approving...' : 'Approve'} aria-label="Approve">
                                      {approvingQid === q.id ? '⋯' : '✓'}
                                    </button>
                                    <button type="button" className="btn btn-sm btn-danger btn-icon-only" onClick={() => handleRejectQuestion(q)} disabled={rejectingQid === q.id} title={rejectingQid === q.id ? 'Rejecting...' : 'Reject'} aria-label="Reject">
                                      {rejectingQid === q.id ? '⋯' : '✕'}
                                    </button>
                                    {(userProfile?.isAdmin === true || userProfile?.isAdmin === 'true') && (
                                      <button type="button" className="btn btn-sm btn-icon-only" onClick={() => handleRemoveQuestion(q)} disabled={removingQid === q.id} title={removingQid === q.id ? 'Removing...' : 'Permanently delete question (admin only)'} aria-label="Remove">
                                        {removingQid === q.id ? '⋯' : '🗑️'}
                                      </button>
                                    )}
                                  </div>
                                </li>
                              );
                              })}
                            </ul>
                          </div>
                        )}
                        {matchAwaiting.length > 0 && (
                          <div className="insight-subsection">
                            <h4>Set correct answer (after match completes)</h4>
                            {!matchCompleted && (
                              <p className="muted" style={{ marginBottom: '0.5rem' }}>Match must be completed first.</p>
                            )}
                            <ul className="rules-list">
                              {matchAwaiting.map(q => (
                                <li key={q.id} className="insight-pending-item">
                                  <div className="insight-pending-content">
                                    <strong>{q.question}</strong>
                                    <span className="muted"> · {q.type === 'yesno' ? 'Yes/No' : q.type === 'multiple' ? 'Multiple Choice' : 'Text'}</span>
                                    {(q.options || []).length > 0 && (
                                      <p className="muted" style={{ margin: '0.25rem 0 0 0' }}>Options: {q.options.join(', ')}</p>
                                    )}
                                  </div>
                                  <div className="insight-pending-actions">
                                    <button
                                      type="button"
                                      className="btn btn-sm btn-primary btn-icon-only"
                                      onClick={() => openAnswerModal(q)}
                                      disabled={submittingAnswer || !matchCompleted}
                                      title={!matchCompleted ? 'Match must be completed first' : 'Set correct answer'}
                                      aria-label="Set correct answer"
                                    >
                                      ✓
                                    </button>
                                    {(userProfile?.isAdmin === true || userProfile?.isAdmin === 'true') && (
                                      <button type="button" className="btn btn-sm btn-icon-only" onClick={() => handleRemoveQuestion(q)} disabled={removingQid === q.id} title={removingQid === q.id ? 'Removing...' : 'Permanently delete question (admin only)'} aria-label="Remove">
                                        {removingQid === q.id ? '⋯' : '🗑️'}
                                      </button>
                                    )}
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {matchPending.length === 0 && matchAwaiting.length === 0 && (
                          <p className="no-matches">No insight questions for this match.</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            );
          })()}
        </section>
        {answerModalQuestion && (
          <div className="modal-overlay" onClick={() => !submittingAnswer && setAnswerModalQuestion(null)}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3>Set Correct Answer</h3>
                <button type="button" className="modal-close" onClick={() => !submittingAnswer && setAnswerModalQuestion(null)} aria-label="Close">&times;</button>
              </div>
              <p className="muted">{answerModalQuestion.question}</p>
              <form onSubmit={handleSetCorrectAnswer}>
                <div className="form-group">
                  <label>Correct Answer</label>
                  {answerModalQuestion.type === 'yesno' && (
                    <select value={correctAnswerInput} onChange={e => setCorrectAnswerInput(e.target.value)} required>
                      <option value="Yes">Yes</option>
                      <option value="No">No</option>
                    </select>
                  )}
                  {answerModalQuestion.type === 'multiple' && (
                    <select value={correctAnswerInput} onChange={e => setCorrectAnswerInput(e.target.value)} required>
                      {(answerModalQuestion.options || []).map(opt => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  )}
                  {answerModalQuestion.type === 'text' && (
                    <input
                      type="text"
                      value={correctAnswerInput}
                      onChange={e => setCorrectAnswerInput(e.target.value)}
                      placeholder="Enter correct answer"
                      required
                    />
                  )}
                </div>
                <div className="modal-actions">
                  <button type="submit" className="btn btn-primary" disabled={submittingAnswer}>
                    {submittingAnswer ? 'Submitting...' : 'Submit Answer & Award Points'}
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => setAnswerModalQuestion(null)} disabled={submittingAnswer}>Cancel</button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
