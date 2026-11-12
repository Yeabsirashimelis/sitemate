import type { ReactNode } from "react";
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from "react-router";
import { Shell } from "./components/shell";
import { Loading } from "./components/ui";
import { useAuth } from "./lib/auth";
import { ApprovalsPage } from "./pages/approvals";
import { LoginPage } from "./pages/login";
import { SignupPage } from "./pages/signup";
import { NotFoundPage } from "./pages/not-found";
import { PortfolioPage } from "./pages/portfolio";
import { ActivityTab } from "./pages/project/activity";
import { ClaimsTab } from "./pages/project/claims";
import { CostTab } from "./pages/project/cost";
import { DailyLogsTab } from "./pages/project/daily-logs";
import { DocumentsTab } from "./pages/project/documents";
import { ProjectLayout } from "./pages/project/layout";
import { LookaheadTab } from "./pages/project/lookahead";
import { MaterialsTab } from "./pages/project/materials";
import { OverviewTab } from "./pages/project/overview";
import { ScheduleTab } from "./pages/project/schedule";
import { TeamPage } from "./pages/team";

function RequireSession({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading label="Signing in" />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/signup", element: <SignupPage /> },
  {
    path: "/",
    element: (
      <RequireSession>
        <Shell />
      </RequireSession>
    ),
    children: [
      { index: true, element: <PortfolioPage /> },
      { path: "approvals", element: <ApprovalsPage /> },
      { path: "team", element: <TeamPage /> },
      {
        path: "projects/:projectId",
        element: <ProjectLayout />,
        children: [
          { index: true, element: <OverviewTab /> },
          { path: "schedule", element: <ScheduleTab /> },
          { path: "lookahead", element: <LookaheadTab /> },
          { path: "materials", element: <MaterialsTab /> },
          { path: "cost", element: <CostTab /> },
          { path: "claims", element: <ClaimsTab /> },
          { path: "logs", element: <DailyLogsTab /> },
          { path: "documents", element: <DocumentsTab /> },
          { path: "activity", element: <ActivityTab /> },
        ],
      },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
