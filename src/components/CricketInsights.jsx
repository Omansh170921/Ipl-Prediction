import { useState, useEffect } from 'react';
import { collection, addDoc, getDocs, query, where, deleteDoc, doc } from 'firebase/firestore';
import { db } from '../firebase/config';
import { useAuth } from '../context/AuthContext';
import { getAppTodayDate } from '../utils/calendarDate';

const QUESTION_TYPES = [
  { value: 'yesno', label: 'Yes / No', options: ['Yes', 'No'] },
  { value: 'multiple', label: 'Multiple Choice', options: [] },
];

export default function CricketInsights({ matchId, matchDate, matchStatus, config = {} }) {
  const { user, userProfile } = useAuth();
  const maxPerUser = Math.max(1, parseInt(config.maxQuestionsPerUserPerMatch, 10) || 1);
  const maxPerMatch = Math.max(1, parseInt(config.maxQuestionsPerMatch, 10) || 5);
  const [questions, setQuestions] = useState([]);
  const [allMatchQuestions, setAllMatchQuestions] = useState([]);
  const [myAnswers, setMyAnswers] = useState({});
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [questionTitle, setQuestionTitle] = useState('');
  const [questionType, setQuestionType] = useState('yesno');
  const [questionOptions, setQuestionOptions] = useState(['', '']);
  const [answerInputs, setAnswerInputs] = useState({});
  const [answerLoading, setAnswerLoading] = useState({});
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [removingQid, setRemovingQid] = useState(null);

  const fetchQuestions = async () => {
    if (!matchId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [approvedSnap, allSnap] = await Promise.all([
        getDocs(query(
          collection(db, 'cricket_questions'),
          where('matchId', '==', matchId),
          where('approved', '==', true)
        )),
        getDocs(query(collection(db, 'cricket_questions'), where('matchId', '==', matchId))),
      ]);
      setQuestions(approvedSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      setAllMatchQuestions(allSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
      console.error('Fetch questions error:', err);
      setError(err?.message || 'Failed to load questions. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const fetchMyAnswers = async () => {
    if (!user) return;
    try {
      const aSnap = await getDocs(
        query(collection(db, 'cricket_answers'), where('userId', '==', user.uid))
      );
      const map = {};
      aSnap.docs.forEach(d => { map[d.data().questionId] = d.data().answer; });
      setMyAnswers(map);
    } catch (err) {
      console.error('Fetch answers error:', err);
    }
  };

  useEffect(() => {
    fetchQuestions();
  }, [user, matchId]);

  useEffect(() => {
    if (questions.length > 0 && user) fetchMyAnswers();
  }, [questions.length, user]);

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(''), 5000);
    return () => clearTimeout(t);
  }, [success]);

  const handleOpenModal = () => {
    setQuestionTitle('');
    setQuestionType('yesno');
    setQuestionOptions(['', '']);
    setError('');
    setSuccess('');
    setShowModal(true);
  };

  const handleAddOption = () => {
    setQuestionOptions(prev => (prev.length >= 4 ? prev : [...prev, '']));
  };

  const handleOptionChange = (idx, val) => {
    setQuestionOptions(prev => {
      const next = [...prev];
      next[idx] = val;
      return next;
    });
  };

  const handleRemoveOption = (idx) => {
    setQuestionOptions(prev => prev.filter((_, i) => i !== idx));
  };

  const handleSubmitQuestion = async (e) => {
    e.preventDefault();
    setError('');
    if ((matchStatus || '').toLowerCase() === 'completed') {
      setError('Match completed. Questions can no longer be asked.');
      return;
    }
    if (!questionTitle.trim() || !user) {
      setError('Please enter a question title.');
      return;
    }
    const myCount = allMatchQuestions.filter(q => q.createdBy === user.uid).length;
    if (myCount >= maxPerUser) {
      setError(`You can only ask ${maxPerUser} question${maxPerUser > 1 ? 's' : ''} per match.`);
      return;
    }
    if (allMatchQuestions.length >= maxPerMatch) {
      setError(`Maximum ${maxPerMatch} questions per match reached.`);
      return;
    }
    const type = questionType;
    let options = [];
    if (type === 'yesno') options = ['Yes', 'No'];
    else if (type === 'multiple') options = questionOptions.filter(o => (o || '').trim());
    if (type === 'multiple' && options.length < 2) {
      setError('Multiple choice questions need at least 2 options. Please fill in the option fields.');
      return;
    }
    setSubmitting(true);
    try {
      await addDoc(collection(db, 'cricket_questions'), {
        matchId,
        question: questionTitle.trim(),
        type,
        options,
        createdBy: user.uid,
        createdAt: new Date().toISOString(),
        approved: false,
        approvedBy: [],
        correctAnswer: null,
        status: 'pending',
      });
      setSuccess('Question submitted! It will appear here after admin approval.');
      setShowModal(false);
      fetchQuestions();
      setSubmitting(false);
    } catch (err) {
      console.error('Submit question error:', err);
      const msg = err?.message || 'Failed to submit question. Please try again.';
      const isPermissionError = /permission|insufficient/i.test(msg);
      setError(isPermissionError
        ? `${msg} Deploy Firestore rules: run \`npx firebase deploy --only firestore:rules\`. Ensure you're logged in.`
        : msg);
      setSubmitting(false);
    }
  };

  const handleSubmitAnswer = async (q) => {
    const answer = answerInputs[q.id];
    if (answer == null || String(answer).trim() === '') return;
    if (myAnswers[q.id]) return;
    if (!user) {
      setError('Please log in to submit an answer.');
      return;
    }
    setError('');
    setAnswerLoading(prev => ({ ...prev, [q.id]: true }));
    try {
      const existsSnap = await getDocs(
        query(collection(db, 'cricket_answers'),
          where('questionId', '==', q.id),
          where('userId', '==', user.uid))
      );
      if (!existsSnap.empty) {
        setMyAnswers(prev => ({ ...prev, [q.id]: existsSnap.docs[0].data().answer }));
        setAnswerLoading(prev => ({ ...prev, [q.id]: false }));
        return;
      }
      await addDoc(collection(db, 'cricket_answers'), {
        questionId: q.id,
        userId: user.uid,
        answer: String(answer).trim(),
        createdAt: new Date().toISOString(),
      });
      setMyAnswers(prev => ({ ...prev, [q.id]: String(answer).trim() }));
    } catch (err) {
      console.error('Submit answer error:', err);
      const msg = err?.message || 'Failed to submit answer. Please try again.';
      const isPermissionError = /permission|insufficient/i.test(msg);
      setError(isPermissionError
        ? `${msg} Deploy Firestore rules: run \`npx firebase deploy --only firestore:rules\`. Ensure you're logged in.`
        : msg);
    }
    setAnswerLoading(prev => ({ ...prev, [q.id]: false }));
  };

  const handleDeleteQuestion = async (q) => {
    if (!confirm(`Permanently delete question: "${(q.question || '').slice(0, 50)}${(q.question || '').length > 50 ? '...' : ''}"? This cannot be undone.`)) return;
    setRemovingQid(q.id);
    try {
      await deleteDoc(doc(db, 'cricket_questions', q.id));
      setQuestions(prev => prev.filter(x => x.id !== q.id));
      setAllMatchQuestions(prev => prev.filter(x => x.id !== q.id));
      setSuccess('Question deleted.');
    } catch (err) {
      console.error('Delete question error:', err);
      setError(err?.message || 'Failed to delete question.');
    }
    setRemovingQid(null);
  };

  if (!matchId) return null;

  const isAdmin = userProfile?.isAdmin === true || userProfile?.isAdmin === 'true';

  const today = getAppTodayDate();
  const isTodayMatch = (matchDate || '') === today;
  const isMatchCompleted = (matchStatus || '').toLowerCase() === 'completed';
  const myQuestionCount = allMatchQuestions.filter(q => q.createdBy === user?.uid).length;
  const totalCount = allMatchQuestions.length;
  const canAskQuestion = user && isTodayMatch && !isMatchCompleted && myQuestionCount < maxPerUser && totalCount < maxPerMatch;

  return (
    <div className="cricket-insights-inline">
      <h4 className="insight-section-title">💡 Cricket Insights</h4>
      <p className="muted insight-section-desc">Ask or answer questions for this match. +1 point for correct answers.</p>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {success && <div className="alert alert-success" role="alert">{success}</div>}
      {canAskQuestion ? (
        <button type="button" className="btn btn-primary" onClick={handleOpenModal}>
          Ask Question
        </button>
      ) : (
        user && (
          isMatchCompleted
            ? <p className="muted">Match completed. Questions can no longer be asked.</p>
            : !isTodayMatch
              ? <p className="muted">Questions can only be asked for today&apos;s matches.</p>
              : totalCount >= maxPerMatch
                ? <p className="muted">Maximum {maxPerMatch} questions per match reached.</p>
                : myQuestionCount >= maxPerUser && <p className="muted">You can ask up to {maxPerUser} question{maxPerUser > 1 ? 's' : ''} per match.</p>
        )
      )}

      {loading ? (
        <p>Loading questions...</p>
      ) : questions.length === 0 ? (
        <p className="no-matches">No approved questions yet. Ask a question or wait for admin approval.</p>
      ) : (
        <div className="insights-questions-list">
          {questions.map(q => {
            const answered = myAnswers[q.id] != null;
            const opts = q.options || [];
            return (
              <div key={q.id} className="insight-question-card">
                <div className="insight-question-header">
                  <div className="insight-question-content">
                    <h4>{q.question}</h4>
                    <p className="muted">Type: {QUESTION_TYPES.find(t => t.value === q.type)?.label || q.type}</p>
                  </div>
                  {isAdmin && (
                    <button
                      type="button"
                      className="btn btn-sm btn-danger btn-icon-only"
                      onClick={() => handleDeleteQuestion(q)}
                      disabled={removingQid === q.id}
                      title={removingQid === q.id ? 'Removing...' : 'Permanently delete question (admin only)'}
                      aria-label="Delete"
                    >
                      {removingQid === q.id ? '⋯' : '🗑️'}
                    </button>
                  )}
                </div>
                {answered ? (
                  <p className="insight-answered">You answered: <strong>{myAnswers[q.id]}</strong></p>
                ) : (
                  <div className="insight-answer-form">
                    {q.type === 'yesno' && (
                      <div className="insight-options">
                        {['Yes', 'No'].map(opt => (
                          <label key={opt} className="insight-option-radio">
                            <input
                              type="radio"
                              name={`q-${q.id}`}
                              value={opt}
                              checked={(answerInputs[q.id] || '') === opt}
                              onChange={() => setAnswerInputs(prev => ({ ...prev, [q.id]: opt }))}
                            />
                            {opt}
                          </label>
                        ))}
                      </div>
                    )}
                    {q.type === 'multiple' && (
                      <div className="insight-options">
                        {opts.map(opt => (
                          <label key={opt} className="insight-option-radio">
                            <input
                              type="radio"
                              name={`q-${q.id}`}
                              value={opt}
                              checked={(answerInputs[q.id] || '') === opt}
                              onChange={() => setAnswerInputs(prev => ({ ...prev, [q.id]: opt }))}
                            />
                            {opt}
                          </label>
                        ))}
                      </div>
                    )}
                    {q.type === 'text' && (
                      <input
                        type="text"
                        className="form-input"
                        placeholder="Your answer"
                        value={answerInputs[q.id] || ''}
                        onChange={(e) => setAnswerInputs(prev => ({ ...prev, [q.id]: e.target.value }))}
                      />
                    )}
                    {(answerInputs[q.id] || '').trim() && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => handleSubmitAnswer(q)}
                        disabled={answerLoading[q.id]}
                      >
                        {answerLoading[q.id] ? 'Submitting...' : 'Submit Answer'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => !submitting && setShowModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Ask Question</h3>
              <button type="button" className="modal-close" onClick={() => !submitting && setShowModal(false)} aria-label="Close">&times;</button>
            </div>
            <form onSubmit={handleSubmitQuestion}>
              {error && <div className="alert alert-error" role="alert">{error}</div>}
              <div className="form-group">
                <label>Question Title</label>
                <input
                  type="text"
                  value={questionTitle}
                  onChange={(e) => setQuestionTitle(e.target.value)}
                  placeholder="e.g. Will Virat Kohli score a half-century?"
                  required
                />
              </div>
              <div className="form-group">
                <label>Question Type</label>
                <select value={questionType} onChange={(e) => setQuestionType(e.target.value)}>
                  {QUESTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              {questionType === 'multiple' && (
                <div className="form-group">
                  <label>Options (up to 4)</label>
                  {questionOptions.map((opt, i) => (
                    <div key={i} className="form-row form-row-option">
                      <input
                        type="text"
                        value={opt}
                        onChange={(e) => handleOptionChange(i, e.target.value)}
                        placeholder={`Option ${i + 1}`}
                      />
                      <button type="button" className="btn btn-sm" onClick={() => handleRemoveOption(i)} disabled={questionOptions.length <= 2}>Remove</button>
                    </div>
                  ))}
                  <button type="button" className="btn btn-sm" onClick={handleAddOption} disabled={questionOptions.length >= 4}>Add Option</button>
                </div>
              )}
              <div className="modal-actions">
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? 'Submitting...' : 'Submit'}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)} disabled={submitting}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
