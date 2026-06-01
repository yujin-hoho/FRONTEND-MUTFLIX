function DashboardSkeleton() {
  return (
    <main className="dashboard-page dashboard-skeleton-page" aria-label="Loading catalog">
      <section className="dashboard-skeleton-hero">
        <span className="image-shimmer" />
        <p className="dashboard-skeleton-status">Preparing catalog and posters...</p>
      </section>
      <section className="dashboard-skeleton-shell">
        {Array.from({ length: 4 }, (_, rowIndex) => (
          <section className="dashboard-skeleton-row" key={rowIndex}>
            <span className="skeleton-block dashboard-skeleton-title" />
            <div>
              {Array.from({ length: 7 }, (_, cardIndex) => (
                <span className="skeleton-block dashboard-skeleton-poster" key={cardIndex} />
              ))}
            </div>
          </section>
        ))}
      </section>
    </main>
  )
}

export default DashboardSkeleton
