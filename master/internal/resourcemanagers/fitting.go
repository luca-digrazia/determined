package resourcemanagers

import (
	"crypto/md5" // #nosec
	"encoding/binary"
	"sort"

	log "github.com/sirupsen/logrus"

	"github.com/determined-ai/determined/master/internal/resourcemanagers/agent"
	"github.com/determined-ai/determined/master/internal/sproto"
	"github.com/determined-ai/determined/master/pkg/actor"
)

// HardConstraint returns true if the task can be assigned to the agent and false otherwise.
type HardConstraint func(req *sproto.AllocateRequest, agent *agent.AgentState) bool

// SoftConstraint returns a score from 0 (lowest) to 1 (highest) representing how optimal is the
// state of the cluster if the task were assigned to the agent.
type SoftConstraint func(req *sproto.AllocateRequest, agent *agent.AgentState) float64

// fittingState is the basis for assigning a task to one or more agents for execution.
type fittingState struct {
	Agent *agent.AgentState
	Score float64
	// Use hash distances besides scores of fitting here in order to
	// load balance across agents for tasks that would have no preference
	// for which agent they go onto if the scores are tied. Use hash distance
	// as an deterministic pseudorandom function for load balance.
	HashDistance uint64
	Slots        int
}

type candidateList []*fittingState

func (c candidateList) Len() int {
	return len(c)
}

func (c candidateList) Less(i, j int) bool {
	// Multiple zero-slot tasks will all end up on the same agent if we only consider the fitting
	// score. To combat this, break ties by selecting the agent whose hashed ID is closest to the
	// hashed ID of the task.

	a := c[i]
	b := c[j]
	switch {
	case a.Score > b.Score:
		return true
	case a.Score < b.Score:
		return false
	case a.HashDistance < b.HashDistance:
		return true
	case a.HashDistance > b.HashDistance:
		return false
	default:
		// As a final tiebreaker, compare the agent IDs in string order.
		return a.Agent.Handler.Address().String() < b.Agent.Handler.Address().String()
	}
}

func (c candidateList) Swap(i, j int) {
	c[j], c[i] = c[i], c[j]
}

func findFits(
	req *sproto.AllocateRequest, agents map[*actor.Ref]*agent.AgentState, fittingMethod SoftConstraint,
) []*fittingState {
	// TODO(DET-4035): Some of this code is duplicated in calculateDesiredNewAgentNum()
	//    to prevent the provisioner from scaling up for jobs that can never be scheduled in
	//    the current cluster configuration.
	if fit := findSharedAgentFit(req, agents, fittingMethod); fit != nil {
		return []*fittingState{fit}
	}
	if req.FittingRequirements.SingleAgent || req.SlotsNeeded <= 1 {
		return nil
	}
	if fits := findDedicatedAgentFits(req, agents, fittingMethod); len(fits) != 0 {
		return fits
	}
	return nil
}

func isViable(
	req *sproto.AllocateRequest, agent *agent.AgentState, constraints ...HardConstraint,
) bool {
	for _, constraint := range constraints {
		if !constraint(req, agent) {
			return false
		}
	}
	return true
}

func findDedicatedAgentFits(
	req *sproto.AllocateRequest, agentStates map[*actor.Ref]*agent.AgentState,
	fittingMethod SoftConstraint,
) []*fittingState {
	if len(agentStates) == 0 {
		return nil
	}

	// Scheduling assumption(s):
	// 1) Multi-agent tasks will receive the same number of slots on every agent. This is
	//    a valid assumption, because the only multi-agent tasks are distributed experiments
	//    which always want equal distribution across agents.
	// 2) Multi-agent tasks will receive all the slots on every agent they are scheduled on.
	agentsByNumSlots := make(map[int][]*agent.AgentState)
	for _, agent := range agentStates {
		constraints := []HardConstraint{labelSatisfied, agentSlotUnusedSatisfied}
		if isViable(req, agent, constraints...) {
			agentsByNumSlots[agent.NumEmptySlots()] = append(agentsByNumSlots[agent.NumEmptySlots()], agent)
		}
	}

	var numSlots sort.IntSlice
	for n := range agentsByNumSlots {
		numSlots = append(numSlots, n)
	}

	// For the distributed case, we want to use as few
	// agents as possible, thus we prioritize the largest agents.
	sort.Sort(sort.Reverse(numSlots))

	var candidateNumSlots int
	for _, n := range numSlots {
		if n == 0 {
			continue
		}

		if s := req.SlotsNeeded; s%n != 0 {
			continue
		}

		maxSlots := len(agentsByNumSlots[n]) * n
		if s := req.SlotsNeeded; maxSlots >= s {
			candidateNumSlots = n
			break
		}
	}

	if candidateNumSlots == 0 {
		log.Debugf("Task: %s which requires %d slots, can not be scheduled onto multiple agents "+
			"in the current cluster configuration. When running on multiple agents, number of "+
			"slots per trial must be either set to 1 or a multiple of the GPUs per agent.",
			req.AllocationID, req.SlotsNeeded,
		)
		return nil
	}

	var candidates candidateList
	for _, agent := range agentsByNumSlots[candidateNumSlots] {
		candidates = append(candidates, &fittingState{
			Agent:        agent,
			Score:        fittingMethod(req, agent),
			HashDistance: hashDistance(req, agent),
		})
	}

	sort.Sort(candidates)

	numContainers := req.SlotsNeeded / candidateNumSlots
	slotsPerContainer := req.SlotsNeeded / numContainers
	fits := candidates[:numContainers]
	for _, c := range fits {
		c.Slots = slotsPerContainer
	}

	return fits
}

func findSharedAgentFit(
	req *sproto.AllocateRequest, agents map[*actor.Ref]*agent.AgentState, fittingMethod SoftConstraint,
) *fittingState {
	var candidates candidateList
	for _, agent := range agents {
		if !isViable(req, agent, slotsSatisfied, maxZeroSlotContainersSatisfied, labelSatisfied) {
			continue
		}

		candidates = append(candidates, &fittingState{
			Agent:        agent,
			Score:        fittingMethod(req, agent),
			HashDistance: hashDistance(req, agent),
		})
	}

	if len(candidates) == 0 {
		return nil
	}

	sort.Sort(candidates)

	candidates[0].Slots = req.SlotsNeeded
	return candidates[0]
}

func stringHashNumber(s string) uint64 {
	// An array must have an address (essentially, be assigned to a variable) to be sliced.
	hash := md5.Sum([]byte(s)) // #nosec
	return binary.LittleEndian.Uint64(hash[:])
}

func hashDistance(req *sproto.AllocateRequest, agent *agent.AgentState) uint64 {
	return stringHashNumber(string(req.AllocationID)) -
		stringHashNumber(agent.Handler.Address().String())
}
