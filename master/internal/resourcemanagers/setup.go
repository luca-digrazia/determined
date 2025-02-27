package resourcemanagers

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"

	"github.com/determined-ai/determined/master/internal/config"
	"github.com/determined-ai/determined/master/internal/db"
	"github.com/determined-ai/determined/master/internal/sproto"

	"github.com/labstack/echo/v4"
	"github.com/pkg/errors"

	"github.com/determined-ai/determined/master/internal/resourcemanagers/agent"
	"github.com/determined-ai/determined/master/pkg/actor"
	"github.com/determined-ai/determined/master/pkg/aproto"
	"github.com/determined-ai/determined/master/pkg/model"
)

func makeTLSConfig(cert *tls.Certificate) (model.TLSClientConfig, error) {
	if cert == nil {
		return model.TLSClientConfig{}, nil
	}
	var content bytes.Buffer
	for _, c := range cert.Certificate {
		if err := pem.Encode(&content, &pem.Block{
			Type:  "CERTIFICATE",
			Bytes: c,
		}); err != nil {
			return model.TLSClientConfig{}, errors.Wrap(err, "failed to encode PEM")
		}
	}

	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return model.TLSClientConfig{}, errors.Wrap(err, "failed to parse certificate")
	}
	certName := ""
	if len(leaf.DNSNames) > 0 {
		certName = leaf.DNSNames[0]
	} else if len(leaf.IPAddresses) > 0 {
		certName = leaf.IPAddresses[0].String()
	}

	return model.TLSClientConfig{
		Enabled:         true,
		CertBytes:       content.Bytes(),
		CertificateName: certName,
	}, nil
}

// Setup sets up the actor and endpoints for resource managers.
func Setup(
	system *actor.System,
	db *db.PgDB,
	echo *echo.Echo,
	config *config.ResourceConfig,
	opts *aproto.MasterSetAgentOptions,
	cert *tls.Certificate,
) *actor.Ref {
	var ref *actor.Ref
	switch {
	case config.ResourceManager.AgentRM != nil:
		ref = setupAgentResourceManager(system, db, echo, config, opts, cert)
	case config.ResourceManager.KubernetesRM != nil:
		tlsConfig, err := makeTLSConfig(cert)
		if err != nil {
			panic(errors.Wrap(err, "failed to set up TLS config"))
		}
		ref = setupKubernetesResourceManager(
			system, echo, config.ResourceManager.KubernetesRM, tlsConfig, opts.LoggingOptions,
		)
	default:
		panic("no expected resource manager config is defined")
	}

	rm, ok := system.ActorOf(actor.Addr("resourceManagers"), &ResourceManagers{ref: ref})
	if !ok {
		panic("cannot create resource managers")
	}
	return rm
}

func setupAgentResourceManager(
	system *actor.System,
	db *db.PgDB,
	echo *echo.Echo,
	config *config.ResourceConfig,
	opts *aproto.MasterSetAgentOptions,
	cert *tls.Certificate,
) *actor.Ref {
	ref, _ := system.ActorOf(
		actor.Addr("agentRM"),
		newAgentResourceManager(db, config, cert),
	)
	system.Ask(ref, actor.Ping{}).Get()

	agent.Initialize(system, echo, opts)
	return ref
}

func setupKubernetesResourceManager(
	system *actor.System,
	echo *echo.Echo,
	config *config.KubernetesResourceManagerConfig,
	masterTLSConfig model.TLSClientConfig,
	loggingConfig model.LoggingConfig,
) *actor.Ref {
	ref, _ := system.ActorOf(
		sproto.K8sRMAddr,
		newKubernetesResourceManager(config, echo, masterTLSConfig, loggingConfig),
	)
	system.Ask(ref, actor.Ping{}).Get()
	return ref
}
