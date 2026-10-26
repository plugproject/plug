import React, { useState } from 'react';
import type {
  ConnectionReport,
  DesignInput,
  DesignRecommendation,
} from '../../../../packages/plug/src/contracts/index';
import type { DesignReviewResult } from '../../../../packages/plug/src/review/index';

interface DesignReviewProps {
  input: DesignInput;
  design: DesignRecommendation;
  report: ConnectionReport;
  revisionId: string | null;
  onAdopt: (
    architectureId: string,
    patterns: string[],
    reviewHash: string,
  ) => Promise<void>;
}

export function DesignReview({
  input,
  design,
  report,
  revisionId,
  onAdopt,
}: DesignReviewProps) {
  const [context, setContext] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [adopting, setAdopting] = useState('');
  const [problem, setProblem] = useState('');
  const [result, setResult] = useState<DesignReviewResult | null>(null);
  const stale = result !== null && result.designHash !== design.designHash;

  const run = async () => {
    setReviewing(true);
    setProblem('');
    try {
      const response = await fetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input,
          connectionId: report.connectionId,
          operationalContext: context,
          ...(revisionId ? { specRevision: revisionId } : {}),
        }),
      });
      const data = (await response
        .json()
        .catch(() => ({}))) as Partial<DesignReviewResult> & { error?: string };
      if (!response.ok || typeof data.error === 'string')
        throw new Error(
          data.error ?? `Design review failed with HTTP ${response.status}.`,
        );
      if (typeof data.reviewHash !== 'string')
        throw new Error('Design review returned no review hash.');
      setResult(data as DesignReviewResult);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setReviewing(false);
    }
  };

  const adopt = async (architectureId: string) => {
    if (!result) return;
    const known = report.architectures.find(
      (candidate) => candidate.id === architectureId,
    );
    const alternative = result.verifiedAlternatives.find(
      (candidate) => candidate.architectureId === architectureId,
    );
    const patterns = known?.patterns ?? alternative?.patterns;
    if (!patterns)
      return setProblem('The reviewed pattern set is unavailable.');
    setAdopting(architectureId);
    setProblem('');
    try {
      await onAdopt(architectureId, patterns, result.reviewHash);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setAdopting('');
    }
  };

  return (
    <section className="design-review" aria-label="Design review">
      <h3>Design review</h3>
      <p className="small">
        A critic reviews a scrubbed design slice, Jev adjudicates typed
        questions, and code keeps feasibility authority. Only you can adopt.
      </p>
      <label>
        Operational context for the review
        <textarea
          value={context}
          maxLength={2000}
          onChange={(event) => setContext(event.target.value)}
          placeholder="For example: the team cannot operate Kafka, or regional data residency is required."
        />
      </label>
      <button disabled={reviewing} onClick={() => void run()}>
        {reviewing ? 'Reviewing…' : 'Review selected designs'}
      </button>
      {problem && (
        <p className="notice error" role="alert">
          {problem}
        </p>
      )}
      {stale && (
        <p className="notice" role="status">
          This review is stale because the design hash changed. Run it again
          before adopting.
        </p>
      )}
      {result && !stale && (
        <div className="review-result">
          <p>
            <strong>{result.decision.disposition.replace('-', ' ')}</strong>
            {result.decision.recommendation
              ? ` · ${result.decision.recommendation}`
              : ' · no recommendation'}
          </p>
          <ul>
            {result.decision.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {result.critique.concerns.length > 0 && (
            <>
              <h4>Evidence-gated concerns</h4>
              <ul>
                {result.critique.concerns.map((concern, index) => (
                  <li key={`${concern.citation}-${index}`}>
                    <a href={`#review-citation-${index}`}>{concern.citation}</a>
                    : {concern.text}
                    <small id={`review-citation-${index}`}>
                      {concern.citedText}
                    </small>
                  </li>
                ))}
              </ul>
            </>
          )}
          {result.decision.adoptable.length > 0 && (
            <div className="review-adoptions">
              {result.decision.adoptable.map((architectureId) => (
                <button
                  className={
                    architectureId === result.decision.recommendation
                      ? 'dark'
                      : ''
                  }
                  disabled={!!adopting}
                  key={architectureId}
                  onClick={() => void adopt(architectureId)}
                >
                  {adopting === architectureId
                    ? 'Adopting…'
                    : `Adopt ${architectureId}`}
                </button>
              ))}
            </div>
          )}
          <p className="hash">
            Critic {result.criticModel} · Jev{' '}
            {result.jevModel ?? 'not configured'}
            <br />
            Review {result.reviewHash}
          </p>
        </div>
      )}
    </section>
  );
}
