import React from 'react';
import { Navigate } from 'react-router-dom';
import { isLoggedIn } from '../services/api';

/**
 * ProtectedRoute component - ensures only authenticated users can access a route.
 * Redirects unauthenticated users to the login page.
 */
export const ProtectedRoute = ({ children }) => {
  if (!isLoggedIn()) {
    return <Navigate to="/" replace />;
  }

  return children;
};

/**
 * PublicRoute component - ensures only unauthenticated users can access a route (like Login).
 * Redirects authenticated users to the dashboard.
 */
export const PublicRoute = ({ children }) => {
  if (isLoggedIn()) {
    return <Navigate to="/dashboard" replace />;
  }

  return children;
};
