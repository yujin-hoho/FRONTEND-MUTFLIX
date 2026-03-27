import { useState } from 'react';
import { X, Eye, EyeOff, Loader2 } from 'lucide-react';
import { loginUser, registerUser } from '../services/api';
import AuthOverlay from './AuthOverlay';

const LoginModal = ({ isOpen, onClose, onLoginSuccess }) => {
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [regToken, setRegToken] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  if (!isOpen) return null;

  const resetForm = () => {
    setUsername('');
    setPassword('');
    setRegToken('');
    setError('');
    setSuccess('');
    setShowPassword(false);
  };

  const switchMode = (newMode) => {
    resetForm();
    setMode(newMode);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError('Please fill in all fields');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await loginUser(username, password, rememberMe);
      onLoginSuccess?.(data);
      onClose();
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSignup = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password.trim() || !regToken.trim()) {
      setError('Please fill in all fields');
      return;
    }
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      await registerUser(username, password, regToken);
      setSuccess('Account created! You can now log in.');
      setTimeout(() => switchMode('login'), 1500);
    } catch (err) {
      setError(err.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div 
        className="absolute inset-0 bg-black/80 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
      ></div>
      <div className="relative z-10 w-full flex justify-center animate-page-enter">
        <AuthOverlay 
          onLoginSuccess={onLoginSuccess} 
          onCancel={onClose}
        />
      </div>
    </div>
  );
};

export default LoginModal;
