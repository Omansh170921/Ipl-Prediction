import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import { fetchSignInMethodsForEmail } from 'firebase/auth';
import { auth } from '../firebase/config';
import { createAndSendOTP } from '../services/otp';

const PENDING_KEY = 'pendingRegistration';

async function checkEmailExists(email) {
  const methods = await fetchSignInMethodsForEmail(auth, (email || '').trim().toLowerCase());
  return methods && methods.length > 0;
}

export default function Register() {
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  useAutoDismiss(error, setError);
  useAutoDismiss(success, setSuccess);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    if (!username.trim()) {
      setError('Username is required');
      return;
    }

    setLoading(true);
    try {
      const exists = await checkEmailExists(email);
      if (exists) {
        setError('This email is already registered. Please login instead.');
        setLoading(false);
        return;
      }
      const timeoutMs = 30000;
      await Promise.race([
        createAndSendOTP(email),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Request timed out. Check your connection and try again.')), timeoutMs)
        ),
      ]);
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({
        email,
        username: username.trim(),
        password,
      }));
      setSuccess('OTP sent to your email! Redirecting...');
      setTimeout(() => navigate('/verify-otp'), 1500);
    } catch (err) {
      const message = err?.message || err?.text || String(err);
      setError(message || 'Failed to send OTP');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Create Account</h1>
        <p className="auth-hint">We'll send a 6-digit OTP to your email for verification</p>
        {error && <div className="alert alert-error alert-toast">{error}</div>}
        {success && <div className="alert alert-success alert-toast">{success}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
            />
          </div>
          <div className="form-group">
            <label>Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Choose a username"
              required
            />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min 6 characters"
              required
            />
          </div>
          <div className="form-group">
            <label>Confirm Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm password"
              required
            />
          </div>
          <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
            {loading ? 'Sending OTP...' : 'Send OTP'}
          </button>
        </form>
        <p className="auth-footer">
          Already have an account? <Link to="/login">Login</Link>
        </p>
      </div>
    </div>
  );
}
