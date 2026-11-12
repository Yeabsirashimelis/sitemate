import { Link } from "react-router";
import { Empty } from "../components/ui";

export function NotFoundPage() {
  return (
    <Empty title="This page does not exist">
      <Link to="/" className="underline underline-offset-2">
        Back to the portfolio
      </Link>
    </Empty>
  );
}
