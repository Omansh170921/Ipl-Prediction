import { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [pendingRedirect, setPendingRedirect] = useState(false);
  const { user, loginWithEmail, loginWithUsername } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from?.pathname || '/dashboard';

  useEffect(() => {
    if (user && pendingRedirect) {
      setPendingRedirect(false);
      navigate(from, { replace: true });
    }
  }, [user, pendingRedirect, navigate, from]);

  useAutoDismiss(error, setError);

  useEffect(() => {
    if (!location.state?.message) return;
    const t = setTimeout(() => {
      navigate(location.pathname, { replace: true, state: { ...location.state, message: undefined } });
    }, 3000);
    return () => clearTimeout(t);
  }, [location.state?.message, location.pathname, location.state, navigate]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    const isEmail = identifier.includes('@');
    const trimmed = identifier.trim();

    try {
      if (isEmail) {
        await loginWithEmail(trimmed.toLowerCase(), password);
      } else {
        await loginWithUsername(trimmed, password);
      }
      setPendingRedirect(true);
    } catch (err) {
      const code = err?.code || '';
      const msg = err?.message || '';
      if (code === 'auth/user-not-found' || msg.includes('User not found')) {
        setError('User not found. Please register.');
      } else {
        setError('Invalid credential please validate.');
      }
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Welcome Back</h1>
        <p className="auth-hint">Login with username or email</p>
        {location.state?.message && <div className="alert alert-success">{location.state.message}</div>}
        {error && <div className="alert alert-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Username or Email</label>
            <input
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="Enter username or email"
              required
            />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              required
            />
          </div>
          <button type="submit" className="btn btn-primary btn-full">Login</button>
        </form>
        <div className="auth-links">
          <Link to="/admin-login">Admin Login</Link>
          <Link to="/login-password">Change Password / Forgot Password</Link>
        </div>
        <p className="auth-footer">
          New user? <Link to="/register">Register</Link>
        </p>
      </div>
    </div>
  );
}
