import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import { doc, getDoc } from 'firebase/firestore';
import { signOut } from 'firebase/auth';
import { auth, db } from '../firebase/config';

export default function AdminLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [pendingRedirect, setPendingRedirect] = useState(false);
  const { user, userProfile, loginWithEmail } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (user && userProfile?.isAdmin && pendingRedirect) {
      setPendingRedirect(false);
      navigate('/admin');
    }
  }, [user, userProfile, pendingRedirect, navigate]);

  useAutoDismiss(error, setError);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    try {
      const { user: signedInUser } = await loginWithEmail(email, password);
      const userDoc = await getDoc(doc(db, 'users', signedInUser.uid));
      if (!userDoc.exists() || !userDoc.data().isAdmin) {
        await signOut(auth);
        setError('Access denied. Admin privileges required.');
        return;
      }
      setPendingRedirect(true);
    } catch (err) {
      setError('Invalid credential please validate.');
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card admin-login">
        <h1>Admin Login</h1>
        {error && <div className="alert alert-error alert-toast">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Admin Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
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
          <button type="submit" className="btn btn-primary btn-full">Admin Login</button>
        </form>
        <p className="auth-footer">
          <Link to="/login">Back to Login</Link>
        </p>
      </div>
    </div>
  );
}
