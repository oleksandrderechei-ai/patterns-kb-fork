---
title: Generalization
description: "Training a model that holds up on unseen data, not just the training set"
area: ml
owner: Oleksandr Derechei
tags: [machine-learning, validation, maintainability]
status: stable
aliases: [overfitting, regularization]
solves: [my model memorised the training data and flops on anything new, my model tested great but keeps getting worse in production, I only have a few hundred labels and my big model overfits immediately, the model was fine at launch and silently degraded months later, my model does badly even on the data it was trained on]
---

# Generalization

Training a model that performs well on new, unseen data rather than memorizing its training set — the property that separates a production-viable model from an expensive science project, and the lens on overfitting, underfitting, and drift.

## What it is
<!--meta block=description-->

A model that scores well on its training data can still fail on data it has not seen, either at once in production or by decaying there quietly. Generalization is the measured ability to perform on new data. Three things break it: overfitting, underfitting and data drift. Every reading depends on an honest split, so you hold data out and keep a final slice you never tune against.

## Explained
<!--meta block=explain-->

Generalization is how well a model does on data it never saw during training, and you measure it by holding some data out and comparing that score with the training score. Training high and held-out low means overfitting: the model memorised noise. Both low means underfitting: it is too simple. Good at first and worse months later means drift: the world moved. Choose it over trusting the training score, because that score only shows what the model remembers.

- **Noisy splits** A single split on a few thousand rows is noisy, so average the score over several folds.
- **Worn-out validation set** Each tuning decision fits the model to it, so keep a final split untouched and read it once.
- **Leaky random splits** Random splits leak when rows are linked in time, so split by date.
- **Ongoing retraining** Drift is never fixed once, so monitor live results and retrain.

**Example.** A churn model trains on 6,000 rows: 4,000 for training, 1,000 for validation and 1,000 held back for testing. At full size it scores 99% on training and 71% on validation, a 28-point gap, so it is overfitting. Shrinking the model and stopping training when validation stops improving gives 84% and 80%, a 4-point gap. After 30 tuning rounds on that validation set, you read the test set once and get 79%, give or take about 1.3 points on 1,000 rows, the number you can quote. The cost is that 1,000 rows sit unused for tuning, and the 79% needs retraining and checking again when live data shifts.

## How it works
<!--meta block=structure-->

```mermaid caption="The gap between the two loss curves is the diagnostic: a widening gap means overfitting, both curves stuck high means underfitting, and a model that fits well then decays in production is facing drift."
flowchart LR
    T["Train"] -->|"fit, then check"| V["Validate on held-out data"]
    V -->|"gap widens"| O["Overfit: regularize (L2, dropout, early stop)"]
    V -->|"both losses high"| U["Underfit: more capacity or features"]
    V -->|"good fit, then decays live"| D["Drift: retrain or update online"]
```

## Variations
<!--meta block=variations-->

- **Regularization** — Constrain the model during training so memorizing noise is harder. L2 (weight decay) keeps weights small and evenly spread, and is the cheap default; L1 pushes weights to zero for feature selection; dropout disables random neurons to force redundant representations; early stopping halts when validation loss stops improving.
- **Cross-validation** — When there is too little data for one held-out split to be trusted, rotate the split. Divide the training set into k parts, fit k times holding each part out in turn, and read the spread of the k scores as well as their mean. A wide spread says the single number you would otherwise have reported was luck. It costs k times the training compute. Keep every row from one patient or one user inside a single fold, and for a time series train only on the past, or the rotation leaks what the split existed to prevent.
- **Transfer learning and small data** — When data is limited, fine-tune a model pretrained on a large corpus rather than training from scratch. Freeze the general lower layers and train only a new head or adapter — BERT fine-tunes on a few thousand examples; a vision backbone classifies from a few hundred per category.
- **Self- and semi-supervised learning** — Learn representations from abundant unlabelled data first (predict masked tokens, reconstruct corrupted inputs), then fine-tune on the scarce labels; or combine a small labelled set with a large unlabelled pool via pseudo-labelling and consistency regularization.
- **Handling drift** — Covariate shift (the inputs change), label shift (the mix of outcomes changes) and concept shift (the link from inputs to outcome changes) call for retraining on fresh data, online learning for rapid adaptation (at the risk of catastrophic forgetting, where new data overwrites what the model learned), or ensembles weighted toward whichever period matches current data.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **A held-out validation split** and a loss-curve plot give a concrete, measurable read on whether a model is over- or underfitting, instead of hand-waving "avoid overfitting".
- **Cheap variance control** — regularization (L2, dropout, early stopping) costs little and lowers variance on the training distribution; it does not remove the need to retrain under drift.
- **Transfer learning makes small-data problems** tractable, reaching useful accuracy from hundreds or thousands of examples.
- **Matching model capacity to available data** is a simple, high-value guard — a smaller model or a logistic-regression baseline resists overfitting.

### Cons
<!--meta polarity=con-->

- **A random validation split leaks information** in some problems (market-wide trends across held-out tickers), so it can report falsely optimistic scores; time-based slicing is often required.
- **High-capacity models need proportionally more data**, and a huge model on a tiny dataset overfits almost immediately.
- **Drift means even a well-generalized** model needs ongoing retraining and monitoring; production retraining pipelines are hard to get right and often neglected.
- **Too much regularization tips into underfitting**; the strength has to be tuned on a validation set.
- **Tuning against the validation split** is also what wears it out: every capacity, regularization and early-stopping decision taken on that score fits the model a little to those rows, so hold a final split back untouched and read it once the model is frozen.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You are choosing a model architecture** and need to match its capacity to how much data you actually have.
- **A deployed model performs far worse** than it did in the notebook — the classic sign of overfitting or a leaky validation split.
- **You have little labelled data** and must decide between transfer learning, augmentation, or a simpler model.
- **A model that tested well** is silently degrading in production and you need to distinguish drift from a bug.

### Avoid when
<!--meta polarity=avoid-->

- **You would reach for heavy regularization** or a complex drift strategy before confirming, from the loss curves, which failure mode you actually have.
- **The task is a one-off analysis** on a fixed dataset with no deployment, where production drift simply does not apply.
- **Training and validation scores are both low**, so the model underfits: add capacity or features before adding regularization.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — early stopping: halt when validation loss stops improving, keep the best checkpoint"
interface Checkpoint { epoch: number; weights: number[]; }

// Stop after `patience` epochs with no improvement, and return the BEST model seen,
// not the last one — training past the minimum is where overfitting sets in.
function trainWithEarlyStopping(
  epochs: number,
  patience: number,
  step: (epoch: number) => { valLoss: number; weights: number[] },
): Checkpoint {
  let best: Checkpoint | null = null;
  let bestLoss = Infinity;
  let sinceImproved = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const { valLoss, weights } = step(epoch);
    if (valLoss < bestLoss) {
      bestLoss = valLoss;
      best = { epoch, weights };
      sinceImproved = 0;
    } else if (++sinceImproved >= patience) {
      break; // validation loss has plateaued — further epochs only overfit
    }
  }
  return best!;
}
```

## In the wild
<!--meta block=wild-->

- **Keras `EarlyStopping`** — A training callback that stops when a monitored validation metric has not improved for `patience` epochs, with `restore_best_weights` to return to the best checkpoint. {#wild-keras-early-stopping}
- **scikit-learn cross-validation** — `cross_val_score` and `Ridge` with its `alpha` penalty give a held-out estimate and an L2 regularization dial. {#wild-sklearn-cv}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Regularization strength** — L2 weight decay, dropout rate or tree depth limits. More lowers variance and raises bias; too much underfits.
- **Model capacity** — Depth, width or number of parameters against the amount of data you have.
- **Early stopping patience** — How many epochs without validation improvement before training stops and the best checkpoint is restored. Choose it from a first run's validation curve: longer than the usual noisy bump, shorter than the stretch where loss only rises.
- **Data size and augmentation** — More examples or transformed copies. Usually the most dependable way to close a train-validation gap, provided the new rows match the live distribution.

### Signals to watch
<!--meta polarity=signal-->

- **Train against validation gap** — The difference in loss or metric. A widening gap is overfitting as it happens.
- **Validation curve over epochs** — Validation loss that bottoms out and rises while training loss keeps falling.
- **Metric on shifted held-out data** — A time-later or different-source sample, which shows what the same-distribution validation set cannot.
- **Production metric against validation metric** — The difference after launch, once labels arrive.

### Failure modes under load
<!--meta polarity=failure-->

- **Overfitting** — Training metric near perfect while validation lags well behind. The model has memorised examples.
- **Tuning against the test set** — Repeated use of the holdout to pick settings makes its score optimistic, and the final number is no longer an unbiased estimate.
- **Near-duplicates across splits** — The same or almost the same example on both sides inflates the score.
- **Over-regularization** — Both train and validation scores stay low, so the model underfits.

### Readiness checklist
<!--meta polarity=check-->

- The test set is used once, after every choice is made
- Duplicates and near-duplicates are removed across splits
- Time-ordered data uses a time-based split
- The train-validation gap is logged for every run
- The model is checked on a shifted sample before release

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [ML System Design](../../themes/ml-system-design.md) — The will-it-hold-up phase: capacity vs data, regularisation, drift {#fluency-ml-system-design}
- [Harmful Content](../../themes/harmful-content.md) — Class imbalance, drift, and the feedback loop of positive suppression {#fluency-harmful-content}
- [Bot Detection](../../themes/bot-detection.md) — Self-supervised pretraining, drift, and survivorship bias {#fluency-bot-detection}
- [Video Recommendations](../../themes/video-recommendations.md) — Cold start for new users and videos, feedback loops, explore/exploit {#fluency-video-recommendations}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Feature Engineering](./feature-engineering.md) — Overfitting and drift usually trace back to feature choices, not the architecture
- [Evaluation](./evaluation.md) — Held-out evaluation is how you detect overfitting and drift
- [Embeddings](./embeddings.md) — Dense vectors generalize where one-hot ids force memorizing every entity

<!-- relationships:end -->
