import { Alert, Tabs } from 'antd';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHistory, useLocation } from 'react-router-dom';

import Link from 'components/Link';
import { terminalRunStates } from 'constants/states';
import { useStore } from 'contexts/Store';
import useStorage from 'hooks/useStorage';
import { paths } from 'routes/utils';
import {
  GetHPImportanceResponseMetricHPImportance,
  V1GetHPImportanceResponse, V1MetricBatchesResponse, V1MetricNamesResponse,
} from 'services/api-ts-sdk';
import { detApi } from 'services/apiConfig';
import { readStream } from 'services/utils';
import Message, { MessageType } from 'shared/components/Message';
import Spinner from 'shared/components/Spinner/Spinner';
import { hasObjectKeys } from 'shared/utils/data';
import { alphaNumericSorter } from 'shared/utils/sort';
import {
  ExperimentBase, ExperimentSearcherName, ExperimentVisualizationType,
  HpImportanceMap, HpImportanceMetricMap, HyperparameterType, MetricName, MetricType, RunState,
  Scale,
} from 'types';

import { hpImportanceSorter } from '../../utils/experiment';

import css from './ExperimentVisualization.module.scss';
import ExperimentVisualizationFilters, {
  MAX_HPARAM_COUNT, ViewType, VisualizationFilters,
} from './ExperimentVisualization/ExperimentVisualizationFilters';
import HpHeatMaps from './ExperimentVisualization/HpHeatMaps';
import HpParallelCoordinates from './ExperimentVisualization/HpParallelCoordinates';
import HpScatterPlots from './ExperimentVisualization/HpScatterPlots';
import LearningCurve from './ExperimentVisualization/LearningCurve';

interface Props {
  basePath: string;
  experiment: ExperimentBase;
  type?: ExperimentVisualizationType;
}

enum PageError {
  MetricBatches,
  MetricHpImportance,
  MetricNames,
}

const STORAGE_PATH = 'experiment-visualization';
const STORAGE_FILTERS_KEY = 'filters';
const TYPE_KEYS = Object.values(ExperimentVisualizationType);
const DEFAULT_TYPE_KEY = ExperimentVisualizationType.LearningCurve;
const DEFAULT_BATCH = 0;
const DEFAULT_BATCH_MARGIN = 10;
const DEFAULT_MAX_TRIALS = 100;
const DEFAULT_VIEW = ViewType.Grid;
const PAGE_ERROR_MESSAGES = {
  [PageError.MetricBatches]: 'Unable to retrieve experiment batches info.',
  [PageError.MetricHpImportance]: 'Unable to retrieve experiment hp importance.',
  [PageError.MetricNames]: 'Unable to retrieve experiment metric info.',
};

const getHpImportanceMap = (
  hpImportanceMetrics: { [key: string]: GetHPImportanceResponseMetricHPImportance },
): HpImportanceMetricMap => {
  const map: HpImportanceMetricMap = {};

  Object.keys(hpImportanceMetrics).forEach((metricName) => {
    map[metricName] = hpImportanceMetrics[metricName].hpImportance || {};
  });

  return map;
};

const ExperimentVisualization: React.FC<Props> = ({
  basePath,
  experiment,
  type,
}: Props) => {
  const { ui } = useStore();
  const history = useHistory();
  const location = useLocation();
  const storage = useStorage(`${STORAGE_PATH}/${experiment.id}`);
  const searcherMetric = useRef<MetricName>({
    name: experiment.config.searcher.metric,
    type: MetricType.Validation,
  });
  const fullHParams = useRef<string[]>(
    (Object.keys(experiment.hyperparameters || {}).filter((key) => {
      // Constant hyperparameters are not useful for visualizations.
      return experiment.hyperparameters[key].type !== HyperparameterType.Constant;
    })),
  );
  const defaultFilters: VisualizationFilters = {
    batch: DEFAULT_BATCH,
    batchMargin: DEFAULT_BATCH_MARGIN,
    hParams: [],
    maxTrial: DEFAULT_MAX_TRIALS,
    metric: searcherMetric.current,
    scale: Scale.Linear,
    view: DEFAULT_VIEW,
  };
  const initFilters = storage.getWithDefault<VisualizationFilters>(
    STORAGE_FILTERS_KEY,
    defaultFilters,
  );
  const [ typeKey, setTypeKey ] = useState(() => {
    return type && TYPE_KEYS.includes(type) ? type : DEFAULT_TYPE_KEY;
  });
  const [ filters, setFilters ] = useState<VisualizationFilters>(initFilters);
  const [ activeMetric, setActiveMetric ] = useState<MetricName>(initFilters.metric);
  const [ batches, setBatches ] = useState<number[]>();
  const [ metrics, setMetrics ] = useState<MetricName[]>();
  const [ hpImportanceMap, setHpImportanceMap ] = useState<HpImportanceMap>();
  const [ pageError, setPageError ] = useState<PageError>();

  const { hasData, hasLoaded, isExperimentTerminal, isSupported } = useMemo(() => {
    return {
      hasData: batches && batches.length !== 0 && metrics && metrics.length !== 0,
      hasLoaded: batches && metrics,
      isExperimentTerminal: terminalRunStates.has(experiment.state),
      isSupported: ![
        ExperimentSearcherName.Single,
        ExperimentSearcherName.Pbt,
      ].includes(experiment.config.searcher.name),
    };
  }, [ batches, experiment, metrics ]);

  const hpImportance = useMemo(() => {
    if (!hpImportanceMap) return {};
    return hpImportanceMap[filters.metric.type][filters.metric.name] || {};
  }, [ filters.metric, hpImportanceMap ]);

  const handleFiltersChange = useCallback((filters: VisualizationFilters) => {
    setFilters(filters);
    storage.set(STORAGE_FILTERS_KEY, filters);
  }, [ storage ]);

  const handleFiltersReset = useCallback(() => {
    storage.remove(STORAGE_FILTERS_KEY);
  }, [ storage ]);

  const handleMetricChange = useCallback((metric: MetricName) => {
    setActiveMetric(metric);
  }, []);

  const handleTabChange = useCallback((type: string) => {
    setTypeKey(type as ExperimentVisualizationType);
    history.replace(`${basePath}/${type}`);
  }, [ basePath, history ]);

  // Sets the default sub route.
  useEffect(() => {
    const isVisualizationRoute = location.pathname.includes(basePath);
    const isInvalidType = type && !TYPE_KEYS.includes(type);
    if (isVisualizationRoute && (!type || isInvalidType)) {
      history.replace(`${basePath}/${typeKey}`);
    }
  }, [ basePath, history, location, type, typeKey ]);

  // Stream available metrics.
  useEffect(() => {
    if (!isSupported || ui.isPageHidden) return;

    const canceler = new AbortController();
    const trainingMetricsMap: Record<string, boolean> = {};
    const validationMetricsMap: Record<string, boolean> = {};

    readStream<V1MetricNamesResponse>(
      detApi.StreamingInternal.metricNames(
        experiment.id,
        undefined,
        { signal: canceler.signal },
      ),
      (event) => {
        if (!event) return;
        /*
         * The metrics endpoint can intermittently send empty lists,
         * so we keep track of what we have seen on our end and
         * only add new metrics we have not seen to the list.
         */
        (event.trainingMetrics || []).forEach((metric) => trainingMetricsMap[metric] = true);
        (event.validationMetrics || []).forEach((metric) => validationMetricsMap[metric] = true);
        const newTrainingMetrics = Object.keys(trainingMetricsMap).sort(alphaNumericSorter);
        const newValidationMetrics = Object.keys(validationMetricsMap).sort(alphaNumericSorter);
        const newMetrics = [
          ...(newValidationMetrics || []).map((name) => ({ name, type: MetricType.Validation })),
          ...(newTrainingMetrics || []).map((name) => ({ name, type: MetricType.Training })),
        ];
        setMetrics(newMetrics);
      },
    ).catch(() => {
      setPageError(PageError.MetricNames);
    });

    readStream<V1GetHPImportanceResponse>(
      detApi.StreamingInternal.getHPImportance(
        experiment.id,
        undefined,
        { signal: canceler.signal },
      ),
      (event) => {
        if (!event) return;
        setHpImportanceMap({
          [MetricType.Training]: getHpImportanceMap(event.trainingMetrics),
          [MetricType.Validation]: getHpImportanceMap(event.validationMetrics),
        });
      },
    ).catch(() => {
      setPageError(PageError.MetricHpImportance);
    });

    return () => canceler.abort();
  }, [ experiment.id, filters?.metric, isSupported, ui.isPageHidden ]);

  // Stream available batches.
  useEffect(() => {
    if (!isSupported || ui.isPageHidden) return;

    const canceler = new AbortController();
    const metricTypeParam = activeMetric.type === MetricType.Training
      ? 'METRIC_TYPE_TRAINING' : 'METRIC_TYPE_VALIDATION';
    const batchesMap: Record<number, number> = {};

    readStream<V1MetricBatchesResponse>(
      detApi.StreamingInternal.metricBatches(
        experiment.id,
        activeMetric.name,
        metricTypeParam,
        undefined,
        { signal: canceler.signal },
      ),
      (event) => {
        if (!event) return;
        (event.batches || []).forEach((batch) => batchesMap[batch] = batch);
        const newBatches = Object.values(batchesMap).sort(alphaNumericSorter);
        setBatches(newBatches);
      },
    ).catch(() => {
      setPageError(PageError.MetricBatches);
    });

    return () => canceler.abort();
  }, [ activeMetric, experiment.id, filters.batch, isSupported, ui.isPageHidden ]);

  // Set the default filter batch.
  useEffect(() => {
    if (!batches || batches.length === 0) return;
    setFilters((prev) => {
      if (prev.batch !== DEFAULT_BATCH) return prev;
      return { ...prev, batch: batches.first() };
    });
  }, [ batches ]);

  // Validate active metric against metrics.
  useEffect(() => {
    setActiveMetric((prev) => {
      const activeMetricFound = (metrics || []).reduce((acc, metric) => {
        return acc || (metric.type === prev.type && metric.name === prev.name);
      }, false);
      return activeMetricFound ? prev : searcherMetric.current;
    });
  }, [ metrics ]);

  // Update default filter hParams if not previously set.
  useEffect(() => {
    if (!isSupported) return;

    setFilters((prev) => {
      if (prev.hParams.length !== 0) return prev;
      const map = hpImportanceMap?.[prev.metric.type]?.[prev.metric.name] || {};
      let hParams = fullHParams.current;
      if (hasObjectKeys(map)) {
        hParams = hParams.sortAll((a, b) => hpImportanceSorter(a, b, map));
      }
      return { ...prev, hParams: hParams.slice(0, MAX_HPARAM_COUNT) };
    });
  }, [ hpImportanceMap, isSupported ]);

  if (!isSupported) {
    const alertMessage = `
      Hyperparameter visualizations are not applicable for single trial or PBT experiments.
    `;
    return (
      <div className={css.alert}>
        <Alert
          description={(
            <>
              Learn about&nbsp;
              <Link
                external
                path={paths.docs('/training-apis/experiment-config.html#searcher')}
                popout>how to run a hyperparameter search
              </Link>.
            </>
          )}
          message={alertMessage}
          type="warning"
        />
      </div>
    );
  } else if (pageError) {
    return <Message title={PAGE_ERROR_MESSAGES[pageError]} type={MessageType.Alert} />;
  } else if (!hasLoaded && experiment.state !== RunState.Paused) {
    return <Spinner tip="Fetching metrics..." />;
  } else if (!hasData) {
    return (isExperimentTerminal || experiment.state === RunState.Paused) ? (
      <Message title="No data to plot." type={MessageType.Empty} />
    ) : (
      <div className={css.alert}>
        <Alert
          description="Please wait until the experiment is further along."
          message="Not enough data points to plot."
        />
        <Spinner center className={css.alertSpinner} />
      </div>
    );
  }

  const visualizationFilters = (
    <ExperimentVisualizationFilters
      batches={batches || []}
      filters={filters}
      fullHParams={fullHParams.current}
      hpImportance={hpImportance}
      metrics={metrics || []}
      type={typeKey}
      onChange={handleFiltersChange}
      onMetricChange={handleMetricChange}
      onReset={handleFiltersReset}
    />
  );

  return (
    <div className={css.base}>
      <Tabs
        activeKey={typeKey}
        destroyInactiveTabPane
        type="card"
        onChange={handleTabChange}>
        <Tabs.TabPane
          key={ExperimentVisualizationType.LearningCurve}
          tab="Learning Curve">
          <LearningCurve
            experiment={experiment}
            filters={visualizationFilters}
            fullHParams={fullHParams.current}
            selectedMaxTrial={filters.maxTrial}
            selectedMetric={filters.metric}
            selectedScale={filters.scale}
          />
        </Tabs.TabPane>
        <Tabs.TabPane
          key={ExperimentVisualizationType.HpParallelCoordinates}
          tab="HP Parallel Coordinates">
          <HpParallelCoordinates
            experiment={experiment}
            filters={visualizationFilters}
            fullHParams={fullHParams.current}
            selectedBatch={filters.batch}
            selectedBatchMargin={filters.batchMargin}
            selectedHParams={filters.hParams}
            selectedMetric={filters.metric}
            selectedScale={filters.scale}
          />
        </Tabs.TabPane>
        <Tabs.TabPane
          key={ExperimentVisualizationType.HpScatterPlots}
          tab="HP Scatter Plots">
          <HpScatterPlots
            experiment={experiment}
            filters={visualizationFilters}
            fullHParams={fullHParams.current}
            selectedBatch={filters.batch}
            selectedBatchMargin={filters.batchMargin}
            selectedHParams={filters.hParams}
            selectedMetric={filters.metric}
            selectedScale={filters.scale}
          />
        </Tabs.TabPane>
        <Tabs.TabPane
          key={ExperimentVisualizationType.HpHeatMap}
          tab="HP Heat Map">
          <HpHeatMaps
            experiment={experiment}
            filters={visualizationFilters}
            fullHParams={fullHParams.current}
            selectedBatch={filters.batch}
            selectedBatchMargin={filters.batchMargin}
            selectedHParams={filters.hParams}
            selectedMetric={filters.metric}
            selectedScale={filters.scale}
            selectedView={filters.view}
          />
        </Tabs.TabPane>
      </Tabs>
    </div>
  );
};

export default ExperimentVisualization;
