import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Landing() {
  const { user, loading } = useAuth();

  if (loading) return <div className="loading-screen"><div className="loader"></div><p>Loading...</p></div>;
  if (user) return <Navigate to="/dashboard" replace />;

  return (
    <div className="landing">
      <div className="landing-content">
        <h1 className="landing-title">
          <span className="cricket">🏏</span> IPL Winner Prediction
        </h1>
        <p className="landing-subtitle">
          Predict the winners of IPL matches. Register now and showcase your cricket expertise!
        </p>
        <div className="landing-buttons">
          <Link to="/login" className="btn btn-primary">Login</Link>
          <Link to="/register" className="btn btn-secondary">Register</Link>
        </div>
      </div>
    </div>
  );
}
