import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import { useAuth } from '../context/AuthContext';
import { sendEmailVerification } from 'firebase/auth';

export default function VerifyEmail() {
  const { user } = useAuth();
  const [resent, setResent] = useState(false);
  const [message, setMessage] = useState('');

  const handleResend = async () => {
    if (!user) return;
    try {
      await sendEmailVerification(user);
      setResent(true);
      setMessage('Verification email sent! Check your inbox.');
    } catch (err) {
      setMessage(err.message);
    }
  };

  useAutoDismiss(message, setMessage);

  useEffect(() => {
    if (user?.emailVerified) {
      window.location.href = '/dashboard';
    }
  }, [user]);

  if (!user) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <p>Please log in first.</p>
          <Link to="/login" className="btn btn-primary">Login</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Verify Your Email</h1>
        <p className="auth-hint">
          We've sent a verification link to <strong>{user.email}</strong>
        </p>
        <p>Click the link in the email to verify your account. Then you can log in with your username and password.</p>
        {message && <div className="alert alert-success">{message}</div>}
        <button onClick={handleResend} className="btn btn-secondary" disabled={resent}>
          {resent ? 'Email Sent' : 'Resend Verification Email'}
        </button>
        <p className="auth-footer">
          <Link to="/login">Back to Login</Link>
        </p>
      </div>
    </div>
  );
}
