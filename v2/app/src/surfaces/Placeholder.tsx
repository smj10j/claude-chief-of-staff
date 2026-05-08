type Props = {
  title: string;
  description: string;
  plannedIn: string;
};

export function Placeholder({ title, description, plannedIn }: Props) {
  return (
    <div className="cos-surface-placeholder">
      <h1>{title}</h1>
      <p>{description}</p>
      <p className="cos-placeholder-muted">Planned in: {plannedIn}</p>
    </div>
  );
}
